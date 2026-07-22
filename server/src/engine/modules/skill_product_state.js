import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { assertMiniAppStateValue } from "./miniapp_compiler.js";

export const SKILL_PRODUCT_STATE_GET_TOOL = "skill_product_state_get";
export const SKILL_PRODUCT_STATE_SET_TOOL = "skill_product_state_set";

const MAX_NAMESPACE_LENGTH = 80;
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_BYTES = 128 * 1024;
const MAX_LIST_ITEMS = 200;

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function parseValue(value) {
  if (value == null || typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function productContext(value = {}) {
  return {
    moduleId: clean(value.module_id || value.moduleId, 200),
    moduleKey: clean(value.module_key || value.moduleKey, 64),
    versionId: clean(value.version_id || value.versionId, 200),
    bindingId: clean(value.binding_id || value.bindingId, 200),
    sessionId: clean(value.session_id || value.sessionId, 200),
  };
}

function stateAddress(input = {}, { keyRequired = false } = {}) {
  const namespace = clean(input.namespace || "default", MAX_NAMESPACE_LENGTH) || "default";
  const key = clean(input.key, MAX_KEY_LENGTH);
  if (keyRequired && !key) throw new ApiError("产品数据缺少 key", 400);
  return { namespace, key };
}

async function requireProductStorageAccess(ctx, rawProduct) {
  const userId = clean(ctx?.userId, 200);
  const product = productContext(rawProduct);
  if (!userId) throw new ApiError("未登录", 401);
  if (!product.moduleId || !product.moduleKey || !product.versionId || !product.bindingId || !product.sessionId) {
    throw new ApiError("Skill Product 数据上下文不完整", 409);
  }
  const permission = `storage:${product.moduleKey}`;
  const row = await ctx.queryOne(
    `SELECT m.id,m.module_key,m.current_version_id,v.state_schema_json
       FROM ui_modules m
       JOIN ui_module_skill_bindings b
         ON b.module_id=m.id AND b.version_id=m.current_version_id
        AND b.id=$4 AND b.owner_user_id=$1 AND b.status='installed' AND b.deleted_at IS NULL
       JOIN ui_module_skill_sessions s
         ON s.module_id=m.id AND s.version_id=m.current_version_id AND s.binding_id=b.id
        AND s.session_id=$5 AND s.owner_user_id=$1 AND s.deleted_at IS NULL
       JOIN ui_module_permission_grants g
         ON g.module_id=m.id AND g.granted_for_version_id=m.current_version_id
        AND g.permission=$6 AND g.status='granted'
       JOIN ui_module_versions v
         ON v.id=m.current_version_id AND v.module_id=m.id AND v.deleted_at IS NULL
      WHERE m.id=$2 AND m.module_key=$3 AND m.owner_user_id=$1
        AND m.status='active' AND m.current_version_id=$7 AND m.deleted_at IS NULL
      LIMIT 1`,
    [
      userId,
      product.moduleId,
      product.moduleKey,
      product.bindingId,
      product.sessionId,
      permission,
      product.versionId,
    ],
  );
  if (!row) throw new ApiError("Skill Product 没有当前版本的数据访问权限", 403);
  return { userId, product, module: row, permission };
}

async function writeStateChangedEvent(ctx, access, result) {
  await ctx.query(
    `INSERT INTO ui_module_events
       (id,module_id,version_id,event_type,actor_user_id,source,detail_json,created_at)
     VALUES ($1,$2,$3,'state.changed',$4,'agent',$5,now())`,
    [randomUUID(), access.product.moduleId, access.product.versionId, access.userId, {
      namespace: result.namespace,
      key: result.key,
      revision: result.revision,
    }],
  ).catch(() => {});
}

function publicState(row, namespace, key) {
  return {
    namespace,
    key,
    value: parseValue(row?.value_json),
    revision: Number(row?.revision || 0),
    exists: Boolean(row),
  };
}

export async function getSkillProductState(ctx, rawProduct, input = {}) {
  const access = await requireProductStorageAccess(ctx, rawProduct);
  const { namespace, key } = stateAddress(input);
  if (key) {
    const row = await ctx.queryOne(
      `SELECT state_key,value_json,revision,updated_at
         FROM ui_module_state
        WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND state_key=$4
          AND deleted_at IS NULL LIMIT 1`,
      [access.product.moduleId, access.userId, namespace, key],
    );
    return publicState(row, namespace, key);
  }
  const rows = await ctx.query(
    `SELECT state_key,value_json,revision,updated_at
       FROM ui_module_state
      WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT ${MAX_LIST_ITEMS}`,
    [access.product.moduleId, access.userId, namespace],
  );
  return {
    namespace,
    items: (rows || []).map((row) => ({
      key: row.state_key,
      value: parseValue(row.value_json),
      revision: Number(row.revision || 0),
      updated_at: row.updated_at,
    })),
  };
}

export async function setSkillProductState(ctx, rawProduct, input = {}) {
  const access = await requireProductStorageAccess(ctx, rawProduct);
  const { namespace, key } = stateAddress(input, { keyRequired: true });
  if (!Object.prototype.hasOwnProperty.call(input, "value")) {
    throw new ApiError("产品数据缺少 value", 400);
  }
  const value = input.value;
  assertMiniAppStateValue(parseValue(access.module.state_schema_json), { namespace, key, value });
  let serialized;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new ApiError("产品数据必须可以转换为 JSON", 400);
  }
  if (Buffer.byteLength(serialized) > MAX_VALUE_BYTES) {
    throw new ApiError(`单条产品数据不能超过 ${MAX_VALUE_BYTES / 1024}KB`, 400);
  }
  const hasExpectedRevision = input.expected_revision !== undefined && input.expected_revision !== null;
  const expectedRevision = hasExpectedRevision ? Number(input.expected_revision) : null;
  if (hasExpectedRevision && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new ApiError("expected_revision 必须是大于等于 0 的整数", 400);
  }
  const existing = await ctx.queryOne(
    `SELECT id,revision FROM ui_module_state
      WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND state_key=$4
        AND deleted_at IS NULL LIMIT 1`,
    [access.product.moduleId, access.userId, namespace, key],
  );
  if (!existing) {
    if (hasExpectedRevision && expectedRevision !== 0) {
      throw new ApiError("产品数据已变化，请重新读取后再保存", 409);
    }
    try {
      await ctx.query(
        `INSERT INTO ui_module_state
           (id,module_id,owner_user_id,namespace,state_key,value_json,revision,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,now(),now())`,
        [randomUUID(), access.product.moduleId, access.userId, namespace, key, value],
      );
    } catch (error) {
      const raced = await ctx.queryOne(
        `SELECT id FROM ui_module_state
          WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND state_key=$4
            AND deleted_at IS NULL LIMIT 1`,
        [access.product.moduleId, access.userId, namespace, key],
      ).catch(() => null);
      if (!raced) throw error;
      throw new ApiError("产品数据已变化，请重新读取后再保存", 409);
    }
    const result = { namespace, key, value, revision: 1, created: true, event: "state.changed" };
    await writeStateChangedEvent(ctx, access, result);
    return result;
  }
  if (hasExpectedRevision && Number(existing.revision) !== expectedRevision) {
    throw new ApiError("产品数据已变化，请重新读取后再保存", 409);
  }
  const params = [value, existing.id, access.product.moduleId, access.userId];
  const revisionClause = hasExpectedRevision ? " AND revision=$5" : "";
  if (hasExpectedRevision) params.push(expectedRevision);
  const updated = await ctx.queryOne(
    `UPDATE ui_module_state SET value_json=$1,revision=revision+1,updated_at=now()
      WHERE id=$2 AND module_id=$3 AND owner_user_id=$4${revisionClause}
      RETURNING revision`,
    params,
  );
  if (!updated) throw new ApiError("产品数据已变化，请重新读取后再保存", 409);
  const result = { namespace, key, value, revision: Number(updated.revision), created: false, event: "state.changed" };
  await writeStateChangedEvent(ctx, access, result);
  return result;
}
