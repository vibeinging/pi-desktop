import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { closeMcpConnection, connectMcpProvider, listAllMcpTools, mcpToolIsReadOnly } from "../agents/mcp_tools.js";
import {
  appVersionSupports,
  moduleChecksum,
  moduleKey,
  nextPatchVersion,
  normalizeModuleContent,
  stableJson,
  validateModuleContent,
  validationHash,
} from "./module_validator.js";
import {
  compileSkillProductMiniApp,
  publicSkillProductBinding,
  resolveSolidifiableSkill,
  skillProductPermission,
  skillSnapshotFingerprint,
} from "./skill_product.js";
import {
  assertMiniAppCommandInput,
  assertMiniAppStateValue,
  buildMiniAppPackage,
  MINIAPP_COMPILER_VERSION,
  MINIAPP_RUNTIME_VERSION,
  normalizeProductBlueprint,
  normalizeRequirementBundle,
  validateMiniAppPackage,
} from "./miniapp_compiler.js";

const MODULE_STATUSES = new Set(["active", "disabled", "error", "incompatible"]);
const MINIAPP_EXPORT_STATUSES = new Set(["draft", "ready", "published", "needs_review", "suspended"]);
const EXPORTABLE_ACTION_TYPES = new Set(["state.get", "state.set", "provider.call"]);
const COMMAND_NAME_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_ACTION_INPUT_BYTES = 64 * 1024;
const MAX_ACTION_OUTPUT_TEXT = 20_000;
const SENSITIVE_OUTPUT_KEY = /(authorization|cookie|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function currentAppVersion() {
  return String(process.env.YIW_APP_VERSION || "0.0.1").trim();
}

function compatibleWithCurrentApp(minAppVersion) {
  return appVersionSupports(String(minAppVersion || "0.0.1"), currentAppVersion());
}

function effectiveModuleStatus(row) {
  if (row?.status === "active" && !compatibleWithCurrentApp(row.min_app_version)) return "incompatible";
  return row?.status;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function requireUser(ctx) {
  const userId = String(ctx?.userId || "").trim();
  if (!userId) throw new ApiError("未登录", 401);
  return userId;
}

function publicVersion(row) {
  if (!row?.version_id) return null;
  return {
    id: row.version_id,
    version: row.version,
    schema_version: Number(row.schema_version || 1),
    min_app_version: row.min_app_version || null,
    checksum: row.checksum,
    status: row.version_status || "installed",
    compiler_version: row.compiler_version || null,
    runtime_version: row.runtime_version || null,
    created_at: row.version_created_at || null,
  };
}

function publicModule(row) {
  return {
    id: row.id,
    module_key: row.module_key,
    name: row.name,
    description: row.description || "",
    icon: row.icon || "sparkles",
    status: effectiveModuleStatus(row),
    source: row.source || "agent",
    agent_exposure: row.agent_exposure || "none",
    sidebar: parseJson(row.sidebar_json),
    current_version: publicVersion(row),
    last_error: row.last_error || null,
    failure_count: Number(row.failure_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicDraft(row) {
  return {
    id: row.id,
    module_id: row.module_id || null,
    module_key: row.module_key,
    base_version_id: row.base_version_id || null,
    target_version: row.target_version || null,
    request_text: row.request_text || "",
    revision: Number(row.revision || 1),
    status: row.status,
    content: {
      manifest: parseJson(row.manifest_json),
      pages: parseJson(row.pages_json),
      actions: parseJson(row.actions_json),
    },
    blueprint: parseJson(row.blueprint_json, null),
    requirements: parseJson(row.requirements_json, null),
    miniapp_package: parseJson(row.package_json, null),
    compiler_version: row.compiler_version || null,
    runtime_version: row.runtime_version || null,
    state_schema: parseJson(row.state_schema_json, null),
    lifecycle: parseJson(row.lifecycle_json, null),
    test_report: parseJson(row.test_report_json, null),
    validation: parseJson(row.validation_json, null),
    validation_hash: row.validation_hash || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
  };
}

function publicMiniAppSkillExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    module_id: row.module_id,
    module_version_id: row.module_version_id,
    skill_name: row.skill_name,
    description: row.skill_description || "",
    export_version: row.export_version,
    status: row.status,
    contract: parseJson(row.contract_json),
    permissions: parseJson(row.permission_json, []),
    validation: parseJson(row.validation_json, null),
    validation_hash: row.validation_hash || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at || null,
    suspended_at: row.suspended_at || null,
  };
}

const moduleSelect = `
  SELECT m.*,
         v.id AS version_id, v.version, v.schema_version, v.min_app_version,
         v.checksum, v.status AS version_status, v.compiler_version, v.runtime_version,
         v.created_at AS version_created_at
    FROM ui_modules m
    LEFT JOIN ui_module_versions v ON v.id=m.current_version_id AND v.deleted_at IS NULL`;

async function ownedModule(ctx, rawId, { includeDisabled = true } = {}) {
  const userId = requireUser(ctx);
  const id = String(rawId || "").trim();
  const row = await ctx.queryOne(
    `${moduleSelect}
      WHERE m.owner_user_id=$1 AND (m.id=$2 OR m.module_key=$2) AND m.deleted_at IS NULL
        ${includeDisabled ? "" : "AND m.status='active'"}
      LIMIT 1`,
    [userId, id],
  );
  if (!row) throw new ApiError("模块不存在", 404);
  const effectiveStatus = effectiveModuleStatus(row);
  if (!includeDisabled && effectiveStatus !== "active") {
    throw new ApiError(effectiveStatus === "incompatible" ? "模块与当前 App 版本不兼容" : "模块不存在", effectiveStatus === "incompatible" ? 409 : 404);
  }
  return row;
}

async function ownedDraft(ctx, rawId) {
  const row = await ctx.queryOne(
    `SELECT * FROM ui_module_drafts
      WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [String(rawId || ""), requireUser(ctx)],
  );
  if (!row) throw new ApiError("模块草稿不存在", 404);
  return row;
}

async function writeEvent(ctx, values = {}) {
  await ctx.query(
    `INSERT INTO ui_module_events
       (id,module_id,version_id,draft_id,event_type,actor_user_id,source,detail_json,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      randomUUID(), values.module_id || null, values.version_id || null, values.draft_id || null,
      values.event_type, values.actor_user_id || ctx.userId || null, values.source || "app", values.detail || {},
    ],
  );
}

function writeEventSync(tx, ctx, values = {}, now = new Date().toISOString()) {
  tx.query(
    `INSERT INTO ui_module_events
       (id,module_id,version_id,draft_id,event_type,actor_user_id,source,detail_json,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(), values.module_id || null, values.version_id || null, values.draft_id || null,
      values.event_type, values.actor_user_id || ctx.userId || null, values.source || "app", values.detail || {}, now,
    ],
  );
}

export async function listModules(ctx, options = {}) {
  const userId = requireUser(ctx);
  const status = String(options.status || "").trim();
  if (status && !MODULE_STATUSES.has(status)) throw new ApiError(`非法模块状态: ${status}`, 400);
  const rows = await ctx.query(
    `${moduleSelect}
      WHERE m.owner_user_id=$1 AND m.deleted_at IS NULL
      ORDER BY CAST(json_extract(m.sidebar_json,'$.order') AS INTEGER), m.created_at`,
    [userId],
  );
  const meta = await ctx.queryOne(`SELECT revision FROM ui_module_registry_meta WHERE id='global'`).catch(() => ({ revision: 0 }));
  const items = rows.map(publicModule).filter((item) => !status || item.status === status);
  return { items, revision: Number(meta?.revision || 0) };
}

export async function getModule(ctx, moduleId) {
  const row = await ownedModule(ctx, moduleId);
  if (!row.version_id) throw new ApiError("模块还没有可运行版本", 409);
  const version = await ctx.queryOne(
    `SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [row.version_id, row.id],
  );
  if (!version) throw new ApiError("模块当前版本不存在", 409);
  const grants = await ctx.query(
    `SELECT permission,status,granted_for_version_id,scope_json
       FROM ui_module_permission_grants
      WHERE module_id=$1 AND status='granted' AND granted_for_version_id=$2`,
    [row.id, row.version_id],
  );
  const bindings = await ctx.query(
    `SELECT provider_alias,provider_type,provider_id,config_json,enabled
       FROM ui_module_provider_bindings WHERE module_id=$1 AND deleted_at IS NULL`,
    [row.id],
  );
  const skillBindings = await ctx.query(
    `SELECT * FROM ui_module_skill_bindings
      WHERE module_id=$1 AND version_id=$2 AND owner_user_id=$3
        AND status='installed' AND deleted_at IS NULL ORDER BY created_at`,
    [row.id, row.version_id, ctx.userId],
  );
  const skillExports = await ctx.query(
    `SELECT * FROM ui_module_skill_exports
      WHERE module_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [row.id, ctx.userId],
  );
  const skillProductSessions = skillBindings.length ? await ctx.query(
    `SELECT s.id,s.title,s.status,s.message_count,s.created_at,s.updated_at,ms.last_run_at
       FROM ui_module_skill_sessions ms
       JOIN sessions s ON s.id=ms.session_id AND s.created_by=ms.owner_user_id AND s.deleted_at IS NULL
      WHERE ms.module_id=$1 AND ms.version_id=$2 AND ms.owner_user_id=$3
        AND ms.deleted_at IS NULL
      ORDER BY COALESCE(ms.last_run_at,s.updated_at) DESC`,
    [row.id, row.version_id, ctx.userId],
  ) : [];
  return {
    ...publicModule(row),
    version: {
      ...publicVersion(row),
      manifest: parseJson(version.manifest_json),
      pages: parseJson(version.pages_json),
      actions: parseJson(version.actions_json),
      validation: parseJson(version.validation_json, null),
      blueprint: parseJson(version.blueprint_json, null),
      requirements: parseJson(version.requirements_json, null),
      miniapp_package: parseJson(version.package_json, null),
      compiler_version: version.compiler_version || null,
      runtime_version: version.runtime_version || null,
      state_schema: parseJson(version.state_schema_json, null),
      lifecycle: parseJson(version.lifecycle_json, null),
      test_report: parseJson(version.test_report_json, null),
    },
    granted_permissions: grants.map((item) => item.permission),
    provider_bindings: Object.fromEntries(bindings.map((item) => [item.provider_alias, {
      provider_type: item.provider_type,
      provider_id: item.provider_id,
      config: parseJson(item.config_json),
      ready: bool(item.enabled),
    }])),
    skill_product: skillBindings.length ? publicSkillProductBinding(skillBindings[0]) : null,
    skill_bindings: skillBindings.map(publicSkillProductBinding),
    agent_skill_exports: skillExports.map(publicMiniAppSkillExport),
    skill_product_sessions: skillProductSessions,
  };
}

export async function listVersions(ctx, moduleId) {
  const module = await ownedModule(ctx, moduleId);
  const rows = await ctx.query(
    `SELECT id,version,schema_version,min_app_version,checksum,status,compiler_version,runtime_version,created_at
       FROM ui_module_versions WHERE module_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [module.id],
  );
  return { module_id: module.id, current_version_id: module.current_version_id, items: rows };
}

export async function getModuleState(ctx, moduleId, options = {}) {
  const module = await ownedModule(ctx, moduleId, { includeDisabled: false });
  const versionId = String(options.version_id || module.current_version_id || "").trim();
  if (!versionId || versionId !== module.current_version_id) throw new ApiError("模块版本已变化，请刷新页面", 409);
  const version = await ctx.queryOne(
    `SELECT manifest_json FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [versionId, module.id],
  );
  if (!version) throw new ApiError("模块当前版本不存在", 409);
  const permission = `storage:${module.module_key}`;
  const permissions = parseJson(version.manifest_json)?.permissions || [];
  if (!permissions.includes(permission)) {
    return { module_id: module.id, version_id: versionId, items: [], state: {}, event_cursor: null };
  }
  await assertPermission(ctx, module.id, versionId, permission);
  const rows = await ctx.query(
    `SELECT namespace,state_key,value_json,revision,updated_at
       FROM ui_module_state
      WHERE module_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL
      ORDER BY namespace,state_key`,
    [module.id, ctx.userId],
  );
  const latestEvent = await ctx.queryOne(
    `SELECT id,created_at FROM ui_module_events
      WHERE module_id=$1 AND version_id=$2 AND event_type='state.changed'
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [module.id, versionId],
  );
  const items = rows.map((row) => ({
    namespace: row.namespace,
    key: row.state_key,
    value: parseJson(row.value_json, null),
    revision: Number(row.revision || 0),
    updated_at: row.updated_at,
  }));
  const state = {};
  for (const item of items) {
    if (item.namespace === "default") state[item.key] = item.value;
    else state[item.namespace] = { ...(state[item.namespace] || {}), [item.key]: item.value };
  }
  return {
    module_id: module.id,
    version_id: versionId,
    items,
    state,
    event_cursor: latestEvent ? { id: latestEvent.id, created_at: latestEvent.created_at } : null,
  };
}

function initialContent(body, key, version, base = null) {
  if (body.content && typeof body.content === "object") {
    return normalizeModuleContent(body.content, { module_key: key, version, name: body.name, description: body.description, icon: body.icon });
  }
  if (base) return normalizeModuleContent({
    manifest: { ...parseJson(base.manifest_json), version },
    pages: parseJson(base.pages_json),
    actions: parseJson(base.actions_json),
  }, { module_key: key, version });
  const permissions = Array.isArray(body.permissions) ? body.permissions : [];
  const page = body.page && typeof body.page === "object" ? body.page : {
    id: "home",
    title: body.name || key,
    layout: {
      type: "Stack",
      children: [
        { type: "Heading", text: body.name || key },
        { type: "Text", text: body.description || "这个模块已经安装，可以继续通过对话完善。" },
      ],
    },
  };
  return normalizeModuleContent({
    manifest: {
      id: key,
      name: body.name || key,
      description: body.description || "",
      icon: body.icon || "sparkles",
      version,
      sidebar: body.sidebar || { visible: true, group: "personal", order: 100 },
      permissions,
      entryPage: page.id || "home",
    },
    pages: body.pages || { [page.id || "home"]: page },
    actions: body.actions || {},
  }, { module_key: key, version });
}

function compileGenericMiniAppDraft(body, { key, content }) {
  if (body.miniapp_package) {
    return {
      blueprint: body.blueprint || null,
      requirements: body.requirements || body.miniapp_package?.requirements || null,
      package: body.miniapp_package,
      compiler_version: body.compiler_version || body.miniapp_package?.compilerVersion || null,
      runtime_version: body.runtime_version || body.miniapp_package?.runtimeVersion || null,
      state_schema: body.state_schema || body.miniapp_package?.stateSchema || null,
      lifecycle: body.lifecycle || body.miniapp_package?.lifecycle || null,
      test_report: body.test_report || null,
    };
  }
  const shouldCompile = Boolean(
    body.compile_miniapp
    || body.blueprint
    || body.requirements
    || body.requirement_sources,
  );
  if (!shouldCompile) {
    return {
      blueprint: null,
      requirements: null,
      package: null,
      compiler_version: null,
      runtime_version: null,
      state_schema: null,
      lifecycle: null,
      test_report: null,
    };
  }
  const requirements = normalizeRequirementBundle(body.requirements, {
    goal: body.request_text || content.manifest.description || content.manifest.name,
    sources: body.requirement_sources,
  });
  const blueprint = normalizeProductBlueprint(body.blueprint, {
    moduleKey: key,
    name: content.manifest.name,
    description: content.manifest.description,
    pages: content.pages,
  });
  if (blueprint.commands.length) {
    throw new ApiError("普通小程序不能在构建阶段声明 agent.intent 命令；请用 actions 实现页面和后端逻辑，安装后再选择发布给主 Agent 的能力", 400);
  }
  const miniappPackage = buildMiniAppPackage({ blueprint, content, requirements });
  return {
    blueprint,
    requirements,
    package: miniappPackage,
    compiler_version: miniappPackage.compilerVersion,
    runtime_version: miniappPackage.runtimeVersion,
    state_schema: miniappPackage.stateSchema,
    lifecycle: miniappPackage.lifecycle,
    test_report: {
      status: "passed",
      checks: ["package.checksum", "requirements.checksum", "blueprint.checksum", "content.checksum"],
      generated_tests: miniappPackage.tests,
    },
  };
}

export async function createDraft(ctx, body = {}) {
  const userId = requireUser(ctx);
  const key = moduleKey(body.module_key || body.content?.manifest?.id || body.name);
  if (!key) throw new ApiError("module_key 不能为空", 400);
  const idempotencyKey = String(body.idempotency_key || "").trim() || null;
  if (idempotencyKey) {
    const existingDraft = await ctx.queryOne(
      `SELECT * FROM ui_module_drafts WHERE owner_user_id=$1 AND idempotency_key=$2 AND deleted_at IS NULL LIMIT 1`,
      [userId, idempotencyKey],
    );
    if (existingDraft) return publicDraft(existingDraft);
  }
  let module = null;
  const requestedBase = String(body.base_module_id || "").trim();
  if (requestedBase) module = await ownedModule(ctx, requestedBase);
  if (!module) {
    module = await ctx.queryOne(
      `${moduleSelect} WHERE m.owner_user_id=$1 AND m.module_key=$2 AND m.deleted_at IS NULL LIMIT 1`,
      [userId, key],
    );
  }
  let baseVersion = null;
  if (module?.current_version_id) {
    baseVersion = await ctx.queryOne(`SELECT * FROM ui_module_versions WHERE id=$1 AND deleted_at IS NULL`, [module.current_version_id]);
  }
  const targetVersion = String(body.version || body.content?.manifest?.version || (baseVersion ? nextPatchVersion(baseVersion.version) : "1.0.0"));
  const content = initialContent(body, key, targetVersion, baseVersion);
  const miniappInput = baseVersion?.package_json && !body.miniapp_package
    ? {
        ...body,
        compile_miniapp: true,
        blueprint: body.blueprint || parseJson(baseVersion.blueprint_json, null),
        requirements: body.requirements || parseJson(baseVersion.requirements_json, null),
      }
    : body;
  const miniapp = compileGenericMiniAppDraft(miniappInput, { key, content });
  const now = new Date().toISOString();
  const draftId = randomUUID();
  let row;
  try {
    row = await ctx.queryOne(
      `INSERT INTO ui_module_drafts
         (id,module_id,module_key,owner_user_id,base_version_id,target_version,request_text,revision,status,
          manifest_json,pages_json,actions_json,blueprint_json,requirements_json,package_json,compiler_version,runtime_version,
          state_schema_json,lifecycle_json,test_report_json,idempotency_key,created_by,updated_by,created_at,updated_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,'editing',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$4,$4,$20,$20,$21)
       RETURNING *`,
      [
        draftId, module?.id || null, key, userId, baseVersion?.id || null, targetVersion,
        String(body.request_text || "").slice(0, 4000), content.manifest, content.pages, content.actions,
        miniapp.blueprint, miniapp.requirements, miniapp.package, miniapp.compiler_version, miniapp.runtime_version,
        miniapp.state_schema, miniapp.lifecycle, miniapp.test_report,
        idempotencyKey, now, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      ],
    );
  } catch (error) {
    if (!idempotencyKey) throw error;
    const racedDraft = await ctx.queryOne(
      `SELECT * FROM ui_module_drafts WHERE owner_user_id=$1 AND idempotency_key=$2 AND deleted_at IS NULL LIMIT 1`,
      [userId, idempotencyKey],
    );
    if (!racedDraft) throw error;
    return publicDraft(racedDraft);
  }
  await writeEvent(ctx, { module_id: module?.id, draft_id: draftId, event_type: "draft.created", source: body.source || "agent", detail: { module_key: key, target_version: targetVersion } });
  return publicDraft(row);
}

export async function createSkillProductDraft(ctx, body = {}) {
  const userId = requireUser(ctx);
  const resolved = await resolveSolidifiableSkill(ctx, {
    skillName: body.skill_name,
    projectId: body.project_id,
    allowedTools: body.allowed_tools,
  });
  const key = moduleKey(body.module_key || body.name || resolved.skill.name);
  if (!key) throw new ApiError("module_key 不能为空", 400);
  const bindingId = randomUUID();
  const compiled = compileSkillProductMiniApp({
    bindingId,
    moduleKey: key,
    name: body.name,
    description: body.description,
    icon: body.icon,
    version: body.version,
    sidebar: body.sidebar,
    pages: body.pages,
    navigation: body.navigation,
    actions: body.actions,
    blueprint: body.blueprint,
    permissions: body.permissions,
    skill: { ...resolved.skill, allowed_tools: resolved.snapshot.allowed_tools },
    skillSnapshot: resolved.snapshot,
    skillFingerprint: resolved.fingerprint,
    projectId: resolved.project_id,
  });
  const content = compiled.content;
  const draft = await createDraft(ctx, {
    module_key: key,
    name: content.manifest.name,
    description: content.manifest.description,
    base_module_id: body.base_module_id,
    version: content.manifest.version,
    request_text: body.request_text || `将 Skill ${resolved.skill.name} 固化为产品`,
    content,
    blueprint: compiled.blueprint,
    miniapp_package: compiled.package,
    compiler_version: compiled.compiler_version,
    runtime_version: compiled.runtime_version,
    state_schema: compiled.state_schema,
    lifecycle: compiled.lifecycle,
    test_report: compiled.test_report,
    idempotency_key: body.idempotency_key ? `skill-product:${body.idempotency_key}` : null,
    source: "skill_product",
  });
  const effectiveBindingId = String(draft.content?.manifest?.product?.bindingId || "");
  if (!effectiveBindingId) {
    throw new ApiError("幂等键已经被另一个非 Skill Product 草稿使用", 409);
  }
  let binding = await ctx.queryOne(
    `SELECT * FROM ui_module_skill_bindings WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [effectiveBindingId, userId],
  );
  if (!binding) {
    const now = new Date().toISOString();
    try {
      binding = await ctx.queryOne(
        `INSERT INTO ui_module_skill_bindings
           (id,draft_id,module_id,version_id,owner_user_id,skill_name,skill_scope,project_id,source_runtime,
            skill_fingerprint,skill_snapshot_json,permission,status,created_at,updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$12)
         RETURNING *`,
        [
          effectiveBindingId, draft.id, draft.module_id || null, userId, resolved.skill.name, resolved.scope,
          resolved.project_id || null, resolved.snapshot.source_runtime, resolved.fingerprint, resolved.snapshot,
          skillProductPermission(key), now,
        ],
      );
    } catch (error) {
      binding = await ctx.queryOne(
        `SELECT * FROM ui_module_skill_bindings WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
        [effectiveBindingId, userId],
      );
      if (!binding) throw error;
    }
  }
  if (
    binding.draft_id !== draft.id
    || binding.skill_name !== resolved.skill.name
    || (binding.project_id || null) !== (resolved.project_id || null)
    || draft.module_key !== key
  ) {
    throw new ApiError("幂等键已经被另一个 Skill Product 请求使用", 409);
  }
  return { ...draft, skill_product: publicSkillProductBinding(binding) };
}

export async function getDraft(ctx, draftId) {
  return publicDraft(await ownedDraft(ctx, draftId));
}

export async function replaceDraft(ctx, draftId, body = {}) {
  const current = await ownedDraft(ctx, draftId);
  const expectedRevision = Number(body.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ApiError("expected_revision 必须为正整数", 400);
  const content = normalizeModuleContent(body.content || {}, {
    module_key: current.module_key,
    version: current.target_version,
  });
  let miniapp = {
    blueprint: null,
    requirements: null,
    package: null,
    compiler_version: null,
    runtime_version: null,
    state_schema: null,
    lifecycle: null,
    test_report: null,
  };
  if (content.manifest.product) {
    const binding = await ctx.queryOne(
      `SELECT * FROM ui_module_skill_bindings
        WHERE draft_id=$1 AND owner_user_id=$2 AND status='draft' AND deleted_at IS NULL LIMIT 1`,
      [current.id, ctx.userId],
    );
    if (!binding) throw new ApiError("Skill Product 执行绑定不存在，不能更新草稿", 409);
    const skillSnapshot = parseJson(binding.skill_snapshot_json, null);
    const blueprint = normalizeProductBlueprint(body.blueprint || parseJson(current.blueprint_json), {
      moduleKey: current.module_key,
      name: content.manifest.name,
      description: content.manifest.description,
      skill: skillSnapshot,
      pages: content.pages,
    });
    const miniappPackage = buildMiniAppPackage({
      blueprint,
      content,
      bindingId: binding.id,
      skillSnapshot,
      skillFingerprint: binding.skill_fingerprint,
      projectId: binding.project_id || null,
    });
    miniapp = {
      blueprint,
      requirements: miniappPackage.requirements || parseJson(current.requirements_json, null),
      package: miniappPackage,
      compiler_version: miniappPackage.compilerVersion,
      runtime_version: miniappPackage.runtimeVersion,
      state_schema: miniappPackage.stateSchema,
      lifecycle: miniappPackage.lifecycle,
      test_report: {
        status: "passed",
        checks: ["package.checksum", "blueprint.checksum", "content.checksum", "command.schema"],
        generated_tests: miniappPackage.tests,
      },
    };
  } else if (current.package_json || body.blueprint || body.requirements || body.requirement_sources) {
    miniapp = compileGenericMiniAppDraft({
      ...body,
      compile_miniapp: true,
      blueprint: body.blueprint || parseJson(current.blueprint_json, null),
      requirements: body.requirements || parseJson(current.requirements_json, null),
      miniapp_package: null,
    }, { key: current.module_key, content });
  }
  const row = await ctx.queryOne(
    `UPDATE ui_module_drafts
        SET manifest_json=$1,pages_json=$2,actions_json=$3,blueprint_json=$4,requirements_json=$5,package_json=$6,
            compiler_version=$7,runtime_version=$8,state_schema_json=$9,lifecycle_json=$10,test_report_json=$11,
            revision=revision+1,status='editing',validation_json=NULL,validation_hash=NULL,updated_by=$12,updated_at=now()
      WHERE id=$13 AND owner_user_id=$12 AND revision=$14 AND deleted_at IS NULL
      RETURNING *`,
    [
      content.manifest, content.pages, content.actions, miniapp.blueprint, miniapp.requirements, miniapp.package,
      miniapp.compiler_version, miniapp.runtime_version, miniapp.state_schema, miniapp.lifecycle,
      miniapp.test_report, ctx.userId, current.id, expectedRevision,
    ],
  );
  if (!row) throw new ApiError("草稿已被更新，请重新加载", 409);
  return publicDraft(row);
}

function collectAgentWorkspaceBindings(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAgentWorkspaceBindings(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.type === "AgentWorkspace") output.push(String(value.bindingId || value.binding_id || "").trim());
  Object.values(value).forEach((item) => collectAgentWorkspaceBindings(item, output));
  return output;
}

async function validateSkillProductBinding(ctx, draft, result) {
  const product = result.normalized?.manifest?.product;
  const draftBindings = await ctx.query(
    `SELECT * FROM ui_module_skill_bindings
      WHERE draft_id=$1 AND owner_user_id=$2 AND status='draft' AND deleted_at IS NULL
      ORDER BY created_at`,
    [draft.id, ctx.userId],
  );
  if (!product && !draftBindings.length) return;
  if (!product && draftBindings.length) {
    result.errors.push({ code: "SKILL_PRODUCT_MANIFEST_REQUIRED", path: "/manifest/product", message: "Skill Product 草稿不能移除产品执行绑定" });
    result.valid = false;
    return;
  }
  const binding = draftBindings.find((item) => item.id === product.bindingId) || null;
  if (!binding) {
    result.errors.push({ code: "SKILL_PRODUCT_BINDING_NOT_FOUND", path: "/manifest/product/bindingId", message: "Skill Product 执行绑定不存在或不属于当前草稿" });
  } else {
    const snapshot = parseJson(binding.skill_snapshot_json, null);
    if (!snapshot || skillSnapshotFingerprint(snapshot) !== binding.skill_fingerprint) {
      result.errors.push({ code: "SKILL_PRODUCT_SNAPSHOT_INVALID", path: "/manifest/product/bindingId", message: "Skill Product 快照校验失败" });
    }
    if (binding.permission !== skillProductPermission(result.normalized.manifest.id)) {
      result.errors.push({ code: "SKILL_PRODUCT_PERMISSION_MISMATCH", path: "/manifest/permissions", message: "Skill Product 权限与模块标识不匹配" });
    }
    if (binding.skill_name !== product.skillName || (binding.project_id || null) !== (product.projectId || null)) {
      result.errors.push({ code: "SKILL_PRODUCT_METADATA_MISMATCH", path: "/manifest/product", message: "Skill Product 元数据与执行绑定不一致" });
    }
    const blueprint = parseJson(draft.blueprint_json, null);
    const miniappPackage = parseJson(draft.package_json, null);
    const packageValidation = validateMiniAppPackage(miniappPackage, {
      content: result.normalized,
      blueprint,
    });
    for (const message of packageValidation.errors) {
      result.errors.push({ code: "MINIAPP_PACKAGE_INVALID", path: "/miniapp_package", message });
    }
    if (miniappPackage?.agent?.bindingId && miniappPackage.agent.bindingId !== binding.id) {
      result.errors.push({ code: "MINIAPP_AGENT_BINDING_MISMATCH", path: "/miniapp_package/agent/bindingId", message: "MiniApp Package 的 Agent 绑定不一致" });
    }
    if (miniappPackage?.skill?.fingerprint && miniappPackage.skill.fingerprint !== binding.skill_fingerprint) {
      result.errors.push({ code: "MINIAPP_SKILL_FINGERPRINT_MISMATCH", path: "/miniapp_package/skill/fingerprint", message: "MiniApp Package 的 Skill 指纹不一致" });
    }
    if (draft.compiler_version !== MINIAPP_COMPILER_VERSION || draft.runtime_version !== MINIAPP_RUNTIME_VERSION) {
      result.errors.push({ code: "MINIAPP_RUNTIME_INCOMPATIBLE", path: "/miniapp_package", message: "MiniApp Package 编译器或运行时版本不兼容" });
    }
    result.miniapp = { blueprint, package: miniappPackage };
  }
  if (draftBindings.length !== 1) {
    result.errors.push({ code: "SKILL_PRODUCT_BINDING_COUNT_INVALID", path: "/manifest/product/bindingId", message: "一个 Skill Product 版本必须且只能有一个执行绑定" });
  }
  const workspaceBindings = Object.values(result.normalized.pages).flatMap((page) => collectAgentWorkspaceBindings(page?.layout));
  if (!workspaceBindings.length) {
    result.errors.push({ code: "SKILL_PRODUCT_WORKSPACE_REQUIRED", path: "/pages", message: "Skill Product 至少需要一个 AgentWorkspace" });
  }
  for (const bindingId of workspaceBindings) {
    if (bindingId !== product.bindingId) {
      result.errors.push({ code: "SKILL_PRODUCT_WORKSPACE_MISMATCH", path: "/pages", message: "AgentWorkspace 必须使用当前产品的执行绑定" });
      break;
    }
  }
  result.valid = result.errors.length === 0;
}

function validateGenericMiniAppPackage(draft, result) {
  if (result.normalized?.manifest?.product || !draft.package_json) return;
  const blueprint = parseJson(draft.blueprint_json, null);
  const miniappPackage = parseJson(draft.package_json, null);
  const packageValidation = validateMiniAppPackage(miniappPackage, {
    content: result.normalized,
    blueprint,
  });
  for (const message of packageValidation.errors) {
    result.errors.push({ code: "MINIAPP_PACKAGE_INVALID", path: "/miniapp_package", message });
  }
  if (draft.compiler_version !== MINIAPP_COMPILER_VERSION || draft.runtime_version !== MINIAPP_RUNTIME_VERSION) {
    result.errors.push({ code: "MINIAPP_RUNTIME_INCOMPATIBLE", path: "/miniapp_package", message: "MiniApp Package 编译器或运行时版本不兼容" });
  }
  result.miniapp = { blueprint, package: miniappPackage };
  result.valid = result.errors.length === 0;
}

async function validateAndPersist(ctx, draft, expectedRevision = null) {
  if (expectedRevision != null && Number(expectedRevision) !== Number(draft.revision)) {
    throw new ApiError("草稿已被更新，请重新加载", 409);
  }
  const result = validateModuleContent({
    manifest: parseJson(draft.manifest_json), pages: parseJson(draft.pages_json), actions: parseJson(draft.actions_json),
  }, { module_key: draft.module_key, version: draft.target_version, current_app_version: currentAppVersion() });
  validateGenericMiniAppPackage(draft, result);
  await validateSkillProductBinding(ctx, draft, result);
  const currentGrantRows = draft.module_id ? await ctx.query(
    `SELECT g.permission FROM ui_module_permission_grants g
      JOIN ui_modules m ON m.id=g.module_id AND m.deleted_at IS NULL
      WHERE g.module_id=$1 AND g.status='granted' AND g.granted_for_version_id=m.current_version_id`,
    [draft.module_id],
  ) : [];
  const currentPermissions = currentGrantRows.map((item) => item.permission);
  const newPermissions = result.requested_permissions.filter((permission) => !currentPermissions.includes(permission));
  const removedPermissions = currentPermissions.filter((permission) => !result.requested_permissions.includes(permission));
  const hash = validationHash(result);
  const payload = {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    requested_permissions: result.requested_permissions,
    new_permissions: newPermissions,
    removed_permissions: removedPermissions,
    stats: result.stats,
  };
  await ctx.query(
    `UPDATE ui_module_drafts SET manifest_json=$1,pages_json=$2,actions_json=$3,validation_json=$4,
       validation_hash=$5,status=$6,updated_at=now() WHERE id=$7 AND owner_user_id=$8 AND deleted_at IS NULL`,
    [result.normalized.manifest, result.normalized.pages, result.normalized.actions, payload, hash, result.valid ? "ready" : "editing", draft.id, ctx.userId],
  );
  await writeEvent(ctx, { module_id: draft.module_id, draft_id: draft.id, event_type: "draft.validated", detail: payload });
  return { ...payload, revision: Number(draft.revision), validation_hash: hash, normalized: result.normalized };
}

export async function validateDraft(ctx, draftId, body = {}) {
  const draft = await ownedDraft(ctx, draftId);
  const result = await validateAndPersist(ctx, draft, body.expected_revision);
  return { ...result, normalized: undefined };
}

export async function previewDraft(ctx, draftId, body = {}) {
  const draft = await ownedDraft(ctx, draftId);
  const result = await validateAndPersist(ctx, draft, body.expected_revision);
  if (!result.valid) throw new ApiError("模块内容检查不通过", 422);
  if (body.validation_hash && body.validation_hash !== result.validation_hash) throw new ApiError("检查结果已变化，请重新预览", 409);
  const previewToken = randomUUID();
  await writeEvent(ctx, {
    module_id: draft.module_id,
    draft_id: draft.id,
    event_type: "preview.opened",
    detail: { revision: Number(draft.revision), validation_hash: result.validation_hash, preview_token: previewToken },
  });
  return {
    draft_id: draft.id,
    module_id: draft.module_id || null,
    module_key: draft.module_key,
    revision: Number(draft.revision),
    entry_page: result.normalized.manifest.entryPage,
    preview_mode: true,
    data_mode: "mock",
    validation_hash: result.validation_hash,
    preview_token: previewToken,
    content: result.normalized,
    expires_at: draft.expires_at,
  };
}

function allPermissionsGranted(permissions, decisions) {
  return permissions.every((permission) => decisions?.[permission] === true);
}

export async function installDraft(ctx, draftId, body = {}) {
  const userId = requireUser(ctx);
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持模块安装事务", 500);
  const draft = await ownedDraft(ctx, draftId);
  if (draft.status === "installed" && draft.module_id) return getModule(ctx, draft.module_id);
  const expectedRevision = Number(body.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ApiError("expected_revision 必须为正整数", 400);
  const checked = await validateAndPersist(ctx, draft, expectedRevision);
  if (!checked.valid) throw new ApiError("模块内容检查不通过", 422);
  const validationHashValue = String(body.validation_hash || "").trim();
  if (!validationHashValue) throw new ApiError("安装前必须先预览模块", 409);
  if (validationHashValue !== checked.validation_hash) throw new ApiError("检查结果已变化，请重新预览", 409);
  const previewToken = String(body.preview_token || "").trim();
  if (!previewToken) throw new ApiError("安装前必须先预览模块", 409);
  const previewEvent = await ctx.queryOne(
    `SELECT detail_json FROM ui_module_events
      WHERE draft_id=$1 AND event_type='preview.opened'
        AND json_extract(detail_json,'$.preview_token')=$2
      ORDER BY created_at DESC LIMIT 1`,
    [draft.id, previewToken],
  );
  const previewDetail = parseJson(previewEvent?.detail_json, null);
  if (!previewDetail
    || previewDetail.preview_token !== previewToken
    || Number(previewDetail.revision) !== expectedRevision
    || previewDetail.validation_hash !== validationHashValue) {
    throw new ApiError("预览内容已变化，请重新预览后安装", 409);
  }
  const decisions = body.permission_decisions && typeof body.permission_decisions === "object" ? body.permission_decisions : {};
  if (!allPermissionsGranted(checked.new_permissions, decisions)) throw new ApiError("模块新增权限尚未全部确认", 403);
  const installKey = String(body.idempotency_key || `install:${draft.id}:${draft.revision}`).slice(0, 200);
  const checksum = moduleChecksum(checked.normalized);
  const now = new Date().toISOString();
  const result = ctx.transaction((tx) => {
    const liveDraft = tx.queryOne(
      `SELECT * FROM ui_module_drafts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [draft.id, userId],
    );
    if (!liveDraft) throw new ApiError("模块草稿不存在", 404);
    if (liveDraft.status === "installed" && liveDraft.module_id) {
      return { module_id: liveDraft.module_id, already_installed: true };
    }
    if (Number(liveDraft.revision) !== expectedRevision) throw new ApiError("草稿已被更新，请重新确认", 409);
    if (liveDraft.status === "installing") throw new ApiError("模块正在安装", 409);
    let module = liveDraft.module_id
      ? tx.queryOne(`SELECT * FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [liveDraft.module_id, userId])
      : tx.queryOne(`SELECT * FROM ui_modules WHERE module_key=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [liveDraft.module_key, userId]);
    if (module && liveDraft.base_version_id && module.current_version_id !== liveDraft.base_version_id) {
      throw new ApiError("模块当前版本已变化，请基于最新版本重新生成草稿", 409);
    }
    const moduleId = module?.id || randomUUID();
    const versionId = randomUUID();
    const skillProductBinding = tx.queryOne(
      `SELECT id FROM ui_module_skill_bindings
        WHERE draft_id=$1 AND owner_user_id=$2 AND status='draft' AND deleted_at IS NULL LIMIT 1`,
      [liveDraft.id, userId],
    );
    if (checked.normalized.manifest.product && !skillProductBinding) {
      throw new ApiError("Skill Product 执行绑定在安装前已失效", 409);
    }
    if (skillProductBinding && checked.normalized.manifest.product?.bindingId !== skillProductBinding.id) {
      throw new ApiError("Skill Product 执行绑定与已检查内容不一致", 409);
    }
    const moduleSource = skillProductBinding ? "skill_product" : "agent";
    const previousExposure = module?.agent_exposure || "none";
    const agentExposure = skillProductBinding
      ? "published"
      : ["draft", "published", "needs_review"].includes(previousExposure)
        ? "needs_review"
        : previousExposure;
    const existingVersion = tx.queryOne(
      `SELECT id FROM ui_module_versions WHERE module_id=$1 AND version=$2 AND deleted_at IS NULL`,
      [moduleId, checked.normalized.manifest.version],
    );
    if (existingVersion) throw new ApiError(`模块版本 ${checked.normalized.manifest.version} 已存在`, 409);
    tx.query(`UPDATE ui_module_drafts SET status='installing',idempotency_key=$1,updated_at=$2 WHERE id=$3`, [installKey, now, liveDraft.id]);
    if (module) {
      tx.query(
        `UPDATE ui_modules SET name=$1,description=$2,icon=$3,status='active',sidebar_json=$4,
           current_version_id=$5,last_error=NULL,failure_count=0,source=$6,agent_exposure=$7,updated_by=$8,updated_at=$9 WHERE id=$10`,
        [checked.normalized.manifest.name, checked.normalized.manifest.description, checked.normalized.manifest.icon,
          checked.normalized.manifest.sidebar, versionId, moduleSource, agentExposure, userId, now, moduleId],
      );
    } else {
      tx.query(
        `INSERT INTO ui_modules
           (id,module_key,owner_user_id,name,description,icon,status,source,agent_exposure,current_version_id,sidebar_json,
            created_by,updated_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$3,$3,$11,$11)`,
        [moduleId, liveDraft.module_key, userId, checked.normalized.manifest.name, checked.normalized.manifest.description,
          checked.normalized.manifest.icon, moduleSource, agentExposure, versionId, checked.normalized.manifest.sidebar, now],
      );
    }
    tx.query(
      `INSERT INTO ui_module_versions
         (id,module_id,version,schema_version,min_app_version,manifest_json,pages_json,actions_json,
          blueprint_json,requirements_json,package_json,compiler_version,runtime_version,state_schema_json,lifecycle_json,test_report_json,
          checksum,status,validation_json,source_request,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'installed',$18,$19,$20,$21)`,
      [versionId, moduleId, checked.normalized.manifest.version, checked.normalized.manifest.schemaVersion,
        checked.normalized.manifest.minAppVersion, checked.normalized.manifest, checked.normalized.pages,
        checked.normalized.actions, parseJson(liveDraft.blueprint_json, null), parseJson(liveDraft.requirements_json, null),
        parseJson(liveDraft.package_json, null),
        liveDraft.compiler_version || null, liveDraft.runtime_version || null, parseJson(liveDraft.state_schema_json, null),
        parseJson(liveDraft.lifecycle_json, null), parseJson(liveDraft.test_report_json, null), checksum, {
          valid: checked.valid, errors: checked.errors, warnings: checked.warnings, stats: checked.stats,
        }, liveDraft.request_text, userId, now],
    );
    for (const permission of checked.requested_permissions) {
      const grant = tx.queryOne(`SELECT id FROM ui_module_permission_grants WHERE module_id=$1 AND permission=$2`, [moduleId, permission]);
      if (grant) {
        tx.query(
          `UPDATE ui_module_permission_grants SET status='granted',granted_for_version_id=$1,granted_by=$2,
             granted_at=$3,revoked_by=NULL,revoked_at=NULL,updated_at=$3 WHERE id=$4`,
          [versionId, userId, now, grant.id],
        );
      } else {
        tx.query(
          `INSERT INTO ui_module_permission_grants
             (id,module_id,permission,status,granted_for_version_id,granted_by,granted_at,created_at,updated_at)
           VALUES ($1,$2,$3,'granted',$4,$5,$6,$6,$6)`,
          [randomUUID(), moduleId, permission, versionId, userId, now],
        );
      }
    }
    const oldGrants = tx.query(
      `SELECT id,permission FROM ui_module_permission_grants WHERE module_id=$1 AND status='granted'`,
      [moduleId],
    );
    for (const grant of oldGrants) {
      if (checked.requested_permissions.includes(grant.permission)) continue;
      tx.query(
        `UPDATE ui_module_permission_grants SET status='revoked',revoked_by=$1,revoked_at=$2,updated_at=$2 WHERE id=$3`,
        [userId, now, grant.id],
      );
    }
    tx.query(
      `UPDATE ui_module_drafts SET module_id=$1,status='installed',validation_hash=$2,updated_by=$3,updated_at=$4 WHERE id=$5`,
      [moduleId, checked.validation_hash, userId, now, liveDraft.id],
    );
    tx.query(
      `UPDATE ui_module_skill_bindings
          SET module_id=$1,version_id=$2,status='installed',updated_at=$3
        WHERE draft_id=$4 AND owner_user_id=$5 AND status='draft' AND deleted_at IS NULL`,
      [moduleId, versionId, now, liveDraft.id, userId],
    );
    tx.query(`UPDATE ui_module_registry_meta SET revision=revision+1,updated_at=$1 WHERE id='global'`, [now]);
    tx.query(
      `INSERT INTO ui_module_events
         (id,module_id,version_id,draft_id,event_type,actor_user_id,source,detail_json,created_at)
       VALUES ($1,$2,$3,$4,'module.installed',$5,'agent',$6,$7)`,
      [randomUUID(), moduleId, versionId, liveDraft.id, userId, { version: checked.normalized.manifest.version, checksum }, now],
    );
    return { module_id: moduleId, version_id: versionId, version: checked.normalized.manifest.version };
  });
  const installed = await getModule(ctx, result.module_id);
  return { ...installed, installed: true, sidebar_changed: true };
}

export async function setModuleStatus(ctx, moduleId, body = {}) {
  const module = await ownedModule(ctx, moduleId);
  if (typeof body.enabled !== "boolean") throw new ApiError("enabled 必须为布尔值", 400);
  if (body.enabled && !compatibleWithCurrentApp(module.min_app_version)) {
    throw new ApiError(`模块需要 YiW ${module.min_app_version} 或更高版本`, 409);
  }
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持模块状态事务", 500);
  const status = body.enabled ? "active" : "disabled";
  const now = new Date().toISOString();
  ctx.transaction((tx) => {
    const live = tx.queryOne(`SELECT id,current_version_id FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [module.id, ctx.userId]);
    if (!live) throw new ApiError("模块不存在", 404);
    tx.query(
      `UPDATE ui_modules SET status=$1,updated_by=$2,updated_at=$3 WHERE id=$4 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [status, ctx.userId, now, live.id],
    );
    tx.query(`UPDATE ui_module_registry_meta SET revision=revision+1,updated_at=$1 WHERE id='global'`, [now]);
    writeEventSync(tx, ctx, { module_id: live.id, version_id: live.current_version_id, event_type: body.enabled ? "module.enabled" : "module.disabled" }, now);
  });
  return publicModule({ ...module, status });
}

export async function activateVersion(ctx, moduleId, versionId, body = {}) {
  const module = await ownedModule(ctx, moduleId);
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持模块退回事务", 500);
  const expected = String(body.expected_current_version_id || "").trim();
  if (expected && expected !== module.current_version_id) throw new ApiError("模块当前版本已变化，请重新加载", 409);
  const version = await ctx.queryOne(
    `SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [versionId, module.id],
  );
  if (!version) throw new ApiError("目标模块版本不存在", 404);
  if (version.status === "blocked") throw new ApiError("目标模块版本已被阻止", 409);
  if (!compatibleWithCurrentApp(version.min_app_version)) {
    throw new ApiError(`目标版本需要 YiW ${version.min_app_version} 或更高版本`, 409);
  }
  const manifest = parseJson(version.manifest_json);
  const targetPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const now = new Date().toISOString();
  ctx.transaction((tx) => {
    const liveModule = tx.queryOne(`SELECT * FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [module.id, ctx.userId]);
    if (!liveModule) throw new ApiError("模块不存在", 404);
    if (expected && expected !== liveModule.current_version_id) throw new ApiError("模块当前版本已变化，请重新加载", 409);
    const liveVersion = tx.queryOne(`SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL`, [version.id, liveModule.id]);
    if (!liveVersion) throw new ApiError("目标模块版本不存在", 404);
    if (liveVersion.status === "blocked") throw new ApiError("目标模块版本已被阻止", 409);
    const grants = tx.query(`SELECT * FROM ui_module_permission_grants WHERE module_id=$1`, [liveModule.id]);
    const grantByPermission = new Map(grants.map((grant) => [grant.permission, grant]));
    const missing = targetPermissions.filter((permission) => !grantByPermission.has(permission));
    if (missing.length) throw new ApiError(`目标版本权限记录不完整，请重新安装: ${missing.join(", ")}`, 409);
    for (const permission of targetPermissions) {
      const grant = grantByPermission.get(permission);
      tx.query(
        `UPDATE ui_module_permission_grants
            SET status='granted',granted_for_version_id=$1,granted_by=$2,granted_at=$3,
                revoked_by=NULL,revoked_at=NULL,updated_at=$3 WHERE id=$4 AND module_id=$5`,
        [liveVersion.id, ctx.userId, now, grant.id, liveModule.id],
      );
    }
    for (const grant of grants) {
      if (targetPermissions.includes(grant.permission) || grant.status !== "granted") continue;
      tx.query(
        `UPDATE ui_module_permission_grants SET status='revoked',revoked_by=$1,revoked_at=$2,updated_at=$2 WHERE id=$3 AND module_id=$4`,
        [ctx.userId, now, grant.id, liveModule.id],
      );
    }
    const targetManifest = parseJson(liveVersion.manifest_json);
    const publishedExport = tx.queryOne(
      `SELECT id FROM ui_module_skill_exports
        WHERE module_id=$1 AND module_version_id=$2 AND owner_user_id=$3
          AND status='published' AND deleted_at IS NULL LIMIT 1`,
      [liveModule.id, liveVersion.id, ctx.userId],
    );
    const anyExport = tx.queryOne(
      `SELECT id FROM ui_module_skill_exports
        WHERE module_id=$1 AND owner_user_id=$2 AND status IN ('draft','ready','published','needs_review')
          AND deleted_at IS NULL LIMIT 1`,
      [liveModule.id, ctx.userId],
    );
    const targetExposure = targetManifest.product
      ? "published"
      : publishedExport
        ? "published"
        : anyExport
          ? "needs_review"
          : "none";
    tx.query(
      `UPDATE ui_modules SET current_version_id=$1,status='active',agent_exposure=$2,last_error=NULL,updated_by=$3,updated_at=$4
        WHERE id=$5 AND owner_user_id=$3 AND deleted_at IS NULL`,
      [liveVersion.id, targetExposure, ctx.userId, now, liveModule.id],
    );
    tx.query(`UPDATE ui_module_registry_meta SET revision=revision+1,updated_at=$1 WHERE id='global'`, [now]);
    writeEventSync(tx, ctx, {
      module_id: liveModule.id,
      version_id: liveVersion.id,
      event_type: "module.rolled_back",
      detail: { from_version_id: liveModule.current_version_id, reason: body.reason || "" },
    }, now);
  });
  return getModule(ctx, module.id);
}

function normalizeExportCommandName(value, fallback) {
  const requested = String(value || "").trim().toLowerCase();
  if (COMMAND_NAME_RE.test(requested)) return requested;
  const normalized = String(fallback || requested)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 80);
  if (!COMMAND_NAME_RE.test(normalized)) throw new ApiError(`无法生成合法的 Agent 命令名: ${value || fallback}`, 400);
  return normalized;
}

function exportContractFromBody(module, version, actions, body = {}) {
  const requestedCommands = Array.isArray(body.commands) ? body.commands : [];
  if (!requestedCommands.length) throw new ApiError("至少选择一个要发布给主 Agent 的小程序动作", 400);
  const seenNames = new Set();
  const seenActions = new Set();
  const commands = requestedCommands.slice(0, 50).map((raw, index) => {
    const input = typeof raw === "string" ? { action: raw } : (raw && typeof raw === "object" ? raw : {});
    const actionName = String(input.action || input.action_name || "").trim();
    if (!actionName || !actions[actionName]) throw new ApiError(`第 ${index + 1} 个导出动作不存在: ${actionName || "(空)"}`, 400);
    if (seenActions.has(actionName)) throw new ApiError(`不能重复导出动作 ${actionName}`, 400);
    seenActions.add(actionName);
    const action = actions[actionName];
    if (!EXPORTABLE_ACTION_TYPES.has(action.type)) {
      throw new ApiError(`动作 ${actionName} 的类型 ${action.type || "(空)"} 不能直接发布给主 Agent`, 400);
    }
    const name = normalizeExportCommandName(input.name || input.command, actionName);
    if (seenNames.has(name)) throw new ApiError(`Agent 命令名重复: ${name}`, 400);
    seenNames.add(name);
    return {
      name,
      title: String(input.title || action.title || actionName).trim().slice(0, 100),
      description: String(input.description || `执行小程序动作 ${actionName}`).trim().slice(0, 1000),
      action: actionName,
      actionType: action.type,
      inputSchema: input.input_schema && typeof input.input_schema === "object"
        ? structuredClone(input.input_schema)
        : { type: "object", additionalProperties: true },
      outputSchema: input.output_schema && typeof input.output_schema === "object"
        ? structuredClone(input.output_schema)
        : { type: "object", additionalProperties: true },
      confirmation: action.type === "state.set" ? "required" : "ask",
      permission: action.permission,
      openPage: input.open_page ? String(input.open_page).trim().slice(0, 80) : null,
    };
  });
  const exportVersion = String(body.export_version || "1.0.0").trim();
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(exportVersion)) {
    throw new ApiError("Agent 能力版本必须使用 x.y.z 格式", 400);
  }
  return {
    schemaVersion: 1,
    kind: "miniapp-agent-skill",
    skill: {
      name: moduleKey(body.skill_name || `${module.module_key}-agent`) || `${module.module_key}-agent`,
      description: String(body.description || `主 Agent 可调用的「${module.name}」能力`).trim().slice(0, 1000),
      version: exportVersion,
    },
    miniapp: {
      moduleId: module.id,
      moduleKey: module.module_key,
      moduleVersionId: version.id,
      moduleVersion: version.version,
      entryPage: parseJson(version.manifest_json).entryPage || null,
    },
    commands,
  };
}

async function ownedMiniAppSkillExport(ctx, exportId) {
  const row = await ctx.queryOne(
    `SELECT e.*,m.module_key,m.name AS module_name,m.status AS module_status,
            m.current_version_id,m.agent_exposure
       FROM ui_module_skill_exports e
       JOIN ui_modules m ON m.id=e.module_id AND m.owner_user_id=e.owner_user_id AND m.deleted_at IS NULL
      WHERE e.id=$1 AND e.owner_user_id=$2 AND e.deleted_at IS NULL LIMIT 1`,
    [String(exportId || "").trim(), requireUser(ctx)],
  );
  if (!row) throw new ApiError("小程序 Agent 能力不存在", 404);
  return row;
}

export async function createMiniAppSkillExportDraft(ctx, moduleId, body = {}) {
  const userId = requireUser(ctx);
  const module = await ownedModule(ctx, moduleId, { includeDisabled: false });
  if (!module.current_version_id) throw new ApiError("小程序还没有可发布的安装版本", 409);
  const version = await ctx.queryOne(
    `SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [module.current_version_id, module.id],
  );
  if (!version) throw new ApiError("小程序当前版本不存在", 409);
  const idempotencyKey = String(body.idempotency_key || "").trim() || null;
  if (idempotencyKey) {
    const existing = await ctx.queryOne(
      `SELECT * FROM ui_module_skill_exports
        WHERE owner_user_id=$1 AND idempotency_key=$2 AND deleted_at IS NULL LIMIT 1`,
      [userId, idempotencyKey],
    );
    if (existing) {
      if (existing.module_id !== module.id || existing.module_version_id !== version.id) {
        throw new ApiError("idempotency_key 已用于另一个小程序或版本", 409);
      }
      return publicMiniAppSkillExport(existing);
    }
  }
  const skillName = moduleKey(body.skill_name || `${module.module_key}-agent`) || `${module.module_key}-agent`;
  const latestExport = await ctx.queryOne(
    `SELECT export_version FROM ui_module_skill_exports
      WHERE owner_user_id=$1 AND skill_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId, skillName],
  );
  const effectiveBody = {
    ...body,
    skill_name: skillName,
    export_version: body.export_version || (latestExport ? nextPatchVersion(latestExport.export_version) : "1.0.0"),
  };
  const actions = parseJson(version.actions_json);
  const contract = exportContractFromBody(module, version, actions, effectiveBody);
  const now = new Date().toISOString();
  const row = await ctx.queryOne(
    `INSERT INTO ui_module_skill_exports
       (id,module_id,module_version_id,owner_user_id,skill_name,skill_description,export_version,status,
        contract_json,permission_json,idempotency_key,created_by,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$4,$11,$11)
     RETURNING *`,
    [
      randomUUID(), module.id, version.id, userId, contract.skill.name, contract.skill.description,
      contract.skill.version, contract, [...new Set(contract.commands.map((command) => command.permission))],
      idempotencyKey, now,
    ],
  );
  if ((module.agent_exposure || "none") === "none") {
    await ctx.query(
      `UPDATE ui_modules SET agent_exposure='draft',updated_by=$1,updated_at=$2 WHERE id=$3 AND owner_user_id=$1`,
      [userId, now, module.id],
    );
  }
  await writeEvent(ctx, {
    module_id: module.id,
    version_id: version.id,
    event_type: "miniapp.skill_export.created",
    source: "agent",
    detail: { export_id: row.id, skill_name: row.skill_name, commands: contract.commands.map((command) => command.name) },
  });
  return publicMiniAppSkillExport(row);
}

async function validateMiniAppSkillExportRow(ctx, row) {
  const contract = parseJson(row.contract_json, null);
  const errors = [];
  const warnings = [];
  if (!contract || contract.kind !== "miniapp-agent-skill" || Number(contract.schemaVersion) !== 1) {
    errors.push({ code: "EXPORT_CONTRACT_INVALID", message: "Agent 能力协议格式不正确" });
  }
  const version = await ctx.queryOne(
    `SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [row.module_version_id, row.module_id],
  );
  if (!version) errors.push({ code: "MODULE_VERSION_MISSING", message: "绑定的小程序版本不存在" });
  if (row.current_version_id !== row.module_version_id) {
    errors.push({ code: "MODULE_VERSION_CHANGED", message: "小程序已经升级，需要基于当前版本重新选择并发布能力" });
  }
  const actions = parseJson(version?.actions_json);
  const grants = version ? await ctx.query(
    `SELECT permission FROM ui_module_permission_grants
      WHERE module_id=$1 AND granted_for_version_id=$2 AND status='granted'`,
    [row.module_id, row.module_version_id],
  ) : [];
  const granted = new Set(grants.map((item) => item.permission));
  const seenNames = new Set();
  for (const command of Array.isArray(contract?.commands) ? contract.commands : []) {
    if (!COMMAND_NAME_RE.test(String(command?.name || ""))) {
      errors.push({ code: "COMMAND_NAME_INVALID", message: `命令名不合法: ${command?.name || "(空)"}` });
    } else if (seenNames.has(command.name)) {
      errors.push({ code: "COMMAND_NAME_DUPLICATE", message: `命令名重复: ${command.name}` });
    }
    seenNames.add(command?.name);
    const action = actions?.[command?.action];
    if (!action) {
      errors.push({ code: "ACTION_MISSING", message: `小程序动作不存在: ${command?.action || "(空)"}` });
      continue;
    }
    if (!EXPORTABLE_ACTION_TYPES.has(action.type)) {
      errors.push({ code: "ACTION_NOT_EXPORTABLE", message: `动作 ${command.action} 不能发布给主 Agent` });
    }
    if (command.actionType !== action.type || command.permission !== action.permission) {
      errors.push({ code: "ACTION_CONTRACT_CHANGED", message: `动作 ${command.action} 的类型或权限已经变化` });
    }
    if (!granted.has(action.permission)) {
      errors.push({ code: "ACTION_PERMISSION_NOT_GRANTED", message: `动作 ${command.action} 的权限尚未授权` });
    }
    if (!command.inputSchema || typeof command.inputSchema !== "object" || Array.isArray(command.inputSchema)) {
      errors.push({ code: "COMMAND_INPUT_SCHEMA_INVALID", message: `命令 ${command.name} 缺少输入结构` });
    }
    if (action.type === "state.set" && command.confirmation !== "required") {
      errors.push({ code: "WRITE_CONFIRMATION_REQUIRED", message: `写入命令 ${command.name} 必须要求确认` });
    }
    if (command.openPage && !parseJson(version?.pages_json)?.[command.openPage]) {
      errors.push({ code: "OPEN_PAGE_MISSING", message: `命令 ${command.name} 的接力页面不存在` });
    }
  }
  if (!Array.isArray(contract?.commands) || !contract.commands.length) {
    errors.push({ code: "EXPORT_COMMAND_REQUIRED", message: "至少需要一个 Agent 命令" });
  }
  const result = {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: contract,
    module_id: row.module_id,
    module_version_id: row.module_version_id,
    command_count: Array.isArray(contract?.commands) ? contract.commands.length : 0,
  };
  return { ...result, validation_hash: validationHash(result) };
}

export async function validateMiniAppSkillExport(ctx, exportId) {
  const row = await ownedMiniAppSkillExport(ctx, exportId);
  if (!MINIAPP_EXPORT_STATUSES.has(row.status)) throw new ApiError(`未知发布状态: ${row.status}`, 409);
  const result = await validateMiniAppSkillExportRow(ctx, row);
  const nextStatus = result.valid
    ? row.status === "published" ? "published" : "ready"
    : ["published", "needs_review"].includes(row.status) ? "needs_review" : "draft";
  await ctx.query(
    `UPDATE ui_module_skill_exports
        SET status=$1,validation_json=$2,validation_hash=$3,updated_at=now()
      WHERE id=$4 AND owner_user_id=$5 AND deleted_at IS NULL`,
    [nextStatus, result, result.validation_hash, row.id, ctx.userId],
  );
  if (nextStatus === "needs_review" && row.agent_exposure === "published") {
    await ctx.query(
      `UPDATE ui_modules SET agent_exposure='needs_review',updated_by=$1,updated_at=now()
        WHERE id=$2 AND owner_user_id=$1 AND deleted_at IS NULL`,
      [ctx.userId, row.module_id],
    );
  }
  return { export: publicMiniAppSkillExport({ ...row, status: nextStatus, validation_json: result, validation_hash: result.validation_hash }), ...result };
}

export async function publishMiniAppSkillExport(ctx, exportId, body = {}) {
  const userId = requireUser(ctx);
  const row = await ownedMiniAppSkillExport(ctx, exportId);
  const result = await validateMiniAppSkillExportRow(ctx, row);
  if (!result.valid) throw new ApiError("Agent 能力检查不通过", 422);
  const expectedHash = String(body.validation_hash || "").trim();
  if (!expectedHash || expectedHash !== result.validation_hash) throw new ApiError("检查结果已变化，请重新检查后发布", 409);
  const now = new Date().toISOString();
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持 Agent 能力发布事务", 500);
  ctx.transaction((tx) => {
    const live = tx.queryOne(
      `SELECT e.*,m.current_version_id FROM ui_module_skill_exports e
        JOIN ui_modules m ON m.id=e.module_id AND m.owner_user_id=e.owner_user_id AND m.deleted_at IS NULL
       WHERE e.id=$1 AND e.owner_user_id=$2 AND e.deleted_at IS NULL`,
      [row.id, userId],
    );
    if (!live || live.module_version_id !== live.current_version_id) throw new ApiError("小程序版本已变化，请重新生成 Agent 能力", 409);
    tx.query(
      `UPDATE ui_module_skill_exports
          SET status='published',validation_json=$1,validation_hash=$2,published_by=$3,
              published_at=$4,suspended_at=NULL,updated_at=$4
        WHERE id=$5 AND owner_user_id=$3 AND deleted_at IS NULL`,
      [result, result.validation_hash, userId, now, live.id],
    );
    tx.query(
      `UPDATE ui_modules SET agent_exposure='published',updated_by=$1,updated_at=$2
        WHERE id=$3 AND owner_user_id=$1 AND deleted_at IS NULL`,
      [userId, now, live.module_id],
    );
    writeEventSync(tx, ctx, {
      module_id: live.module_id,
      version_id: live.module_version_id,
      event_type: "miniapp.skill_export.published",
      source: "agent",
      detail: { export_id: live.id, skill_name: live.skill_name },
    }, now);
  });
  return publicMiniAppSkillExport(await ownedMiniAppSkillExport(ctx, row.id));
}

export async function suspendMiniAppSkillExport(ctx, exportId) {
  const userId = requireUser(ctx);
  const row = await ownedMiniAppSkillExport(ctx, exportId);
  const now = new Date().toISOString();
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持 Agent 能力停用事务", 500);
  ctx.transaction((tx) => {
    tx.query(
      `UPDATE ui_module_skill_exports SET status='suspended',suspended_at=$1,updated_at=$1
        WHERE id=$2 AND owner_user_id=$3 AND deleted_at IS NULL`,
      [now, row.id, userId],
    );
    const liveModule = tx.queryOne(
      `SELECT current_version_id FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [row.module_id, userId],
    );
    const remaining = tx.queryOne(
      `SELECT id FROM ui_module_skill_exports
        WHERE module_id=$1 AND module_version_id=$2 AND owner_user_id=$3
          AND status='published' AND id<>$4 AND deleted_at IS NULL LIMIT 1`,
      [row.module_id, liveModule?.current_version_id || "", userId, row.id],
    );
    const legacyBinding = tx.queryOne(
      `SELECT id FROM ui_module_skill_bindings
        WHERE module_id=$1 AND version_id=$2 AND owner_user_id=$3
          AND status='installed' AND deleted_at IS NULL LIMIT 1`,
      [row.module_id, liveModule?.current_version_id || "", userId],
    );
    const remainingDraft = tx.queryOne(
      `SELECT id FROM ui_module_skill_exports
        WHERE module_id=$1 AND module_version_id=$2 AND owner_user_id=$3
          AND status IN ('draft','ready') AND id<>$4 AND deleted_at IS NULL LIMIT 1`,
      [row.module_id, liveModule?.current_version_id || "", userId, row.id],
    );
    const nextExposure = remaining || legacyBinding ? "published" : remainingDraft ? "draft" : "none";
    tx.query(
      `UPDATE ui_modules SET agent_exposure=$1,updated_by=$2,updated_at=$3
        WHERE id=$4 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [nextExposure, userId, now, row.module_id],
    );
    writeEventSync(tx, ctx, {
      module_id: row.module_id,
      version_id: row.module_version_id,
      event_type: "miniapp.skill_export.suspended",
      source: "agent",
      detail: { export_id: row.id, skill_name: row.skill_name },
    }, now);
  });
  return publicMiniAppSkillExport(await ownedMiniAppSkillExport(ctx, row.id));
}

export async function listMiniAppAgentSkills(ctx, options = {}) {
  const userId = requireUser(ctx);
  const status = String(options.status || "published").trim();
  if (status && !MINIAPP_EXPORT_STATUSES.has(status)) throw new ApiError(`非法 Agent 能力状态: ${status}`, 400);
  const rows = await ctx.query(
    `SELECT e.*,m.module_key,m.name AS module_name,m.status AS module_status,
            m.current_version_id,m.agent_exposure
       FROM ui_module_skill_exports e
       JOIN ui_modules m ON m.id=e.module_id AND m.owner_user_id=e.owner_user_id AND m.deleted_at IS NULL
      WHERE e.owner_user_id=$1 AND e.deleted_at IS NULL
        ${status ? "AND e.status=$2" : ""}
      ORDER BY COALESCE(e.published_at,e.created_at) DESC`,
    status ? [userId, status] : [userId],
  );
  return {
    items: rows.map((row) => ({
      ...publicMiniAppSkillExport(row),
      module_key: row.module_key,
      module_name: row.module_name,
      module_status: row.module_status,
      callable: row.status === "published"
        && row.module_status === "active"
        && row.agent_exposure === "published"
        && row.current_version_id === row.module_version_id,
    })),
  };
}

export async function useMiniAppAgentSkill(ctx, options = {}) {
  const userId = requireUser(ctx);
  const exportId = String(options.export_id || "").trim();
  const skillName = String(options.skill_name || "").trim();
  if (!exportId && !skillName) throw new ApiError("export_id 或 skill_name 为必填项", 400);
  const row = await ctx.queryOne(
    `SELECT e.*,m.module_key,m.name AS module_name,m.status AS module_status,
            m.current_version_id,m.agent_exposure
       FROM ui_module_skill_exports e
       JOIN ui_modules m ON m.id=e.module_id AND m.owner_user_id=e.owner_user_id AND m.deleted_at IS NULL
      WHERE e.owner_user_id=$1 AND e.status='published' AND e.deleted_at IS NULL
        AND (${exportId ? "e.id=$2" : "e.skill_name=$2"})
      ORDER BY e.published_at DESC LIMIT 1`,
    [userId, exportId || skillName],
  );
  if (!row) throw new ApiError("没有找到已发布的小程序 Agent 能力", 404);
  if (row.module_status !== "active") throw new ApiError("小程序当前没有启用", 409);
  if (row.agent_exposure !== "published" || row.current_version_id !== row.module_version_id) {
    throw new ApiError("小程序已经升级或能力需要重新检查，当前不能由主 Agent 调用", 409);
  }
  const contract = parseJson(row.contract_json);
  const commandName = String(options.command || "").trim();
  const command = (contract.commands || []).find((item) => item.name === commandName);
  if (!command) throw new ApiError(`Agent 命令不存在: ${commandName || "(空)"}`, 404);
  const input = options.input && typeof options.input === "object" && !Array.isArray(options.input) ? options.input : {};
  assertMiniAppCommandInput(input, command.inputSchema);
  const requestedRequestId = String(options.request_id || "").trim();
  if (requestedRequestId.length > 200) throw new ApiError("request_id 不能超过 200 个字符", 400);
  const requestId = requestedRequestId || randomUUID();
  const existing = await ctx.queryOne(
    `SELECT * FROM ui_miniapp_invocations WHERE owner_user_id=$1 AND request_id=$2 LIMIT 1`,
    [userId, requestId],
  );
  if (existing) {
    if (existing.export_id !== row.id || existing.command_name !== command.name) {
      throw new ApiError("request_id 已用于其他小程序命令", 409);
    }
    if (stableJson(parseJson(existing.input_json)) !== stableJson(input)) {
      throw new ApiError("request_id 已用于不同的小程序命令输入", 409);
    }
    if (existing.status === "completed") {
      const output = parseJson(existing.output_json, null) || {};
      return { invocation_id: existing.id, request_id: requestId, status: "completed", ...output, idempotent_replay: true };
    }
    if (existing.status === "running") throw new ApiError("相同小程序命令正在执行", 409);
  }
  const invocationId = existing?.id || randomUUID();
  if (existing) {
    await ctx.query(
      `UPDATE ui_miniapp_invocations SET status='running',input_json=$1,error_code=NULL,error_message=NULL,
          started_at=now(),finished_at=NULL,updated_at=now() WHERE id=$2`,
      [input, invocationId],
    );
  } else {
    await ctx.query(
      `INSERT INTO ui_miniapp_invocations
         (id,request_id,export_id,module_id,module_version_id,owner_user_id,command_name,action_name,status,
          input_json,started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now(),now(),now())`,
      [invocationId, requestId, row.id, row.module_id, row.module_version_id, userId, command.name, command.action, input],
    );
  }
  try {
    const actionResult = await runModuleAction(ctx, row.module_id, command.action, {
      request_id: `agent-${invocationId}`,
      version_id: row.module_version_id,
      input,
    });
    const output = {
      data: actionResult.data,
      state_patch: actionResult.state_patch || [],
      handoff: command.openPage ? { module_id: row.module_id, page_id: command.openPage, invocation_id: invocationId } : null,
    };
    await ctx.query(
      `UPDATE ui_miniapp_invocations SET status='completed',output_json=$1,finished_at=now(),updated_at=now() WHERE id=$2`,
      [output, invocationId],
    );
    return { invocation_id: invocationId, request_id: requestId, status: "completed", ...output };
  } catch (error) {
    await ctx.query(
      `UPDATE ui_miniapp_invocations SET status='failed',error_code=$1,error_message=$2,finished_at=now(),updated_at=now() WHERE id=$3`,
      [error?.code || error?.status || "MINIAPP_INVOCATION_FAILED", String(error?.message || error).slice(0, 2000), invocationId],
    ).catch(() => {});
    throw error;
  }
}

export async function openMiniApp(ctx, moduleId, options = {}) {
  const module = await getModule(ctx, moduleId);
  if (module.status !== "active") throw new ApiError("小程序当前没有启用", 409);
  const pageId = String(options.page_id || module.version.manifest.entryPage || "").trim();
  if (!module.version.pages[pageId]) throw new ApiError(`小程序页面不存在: ${pageId}`, 404);
  const invocationId = String(options.invocation_id || "").trim() || null;
  if (invocationId) {
    const invocation = await ctx.queryOne(
      `SELECT id FROM ui_miniapp_invocations
        WHERE id=$1 AND module_id=$2 AND owner_user_id=$3 AND status='completed' LIMIT 1`,
      [invocationId, module.id, ctx.userId],
    );
    if (!invocation) throw new ApiError("页面接力记录不存在或不属于当前小程序", 404);
  }
  return {
    module_id: module.id,
    module_key: module.module_key,
    page_id: pageId,
    invocation_id: invocationId,
  };
}

export async function deleteModule(ctx, moduleId) {
  const module = await ownedModule(ctx, moduleId);
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持模块删除事务", 500);
  const now = new Date().toISOString();
  ctx.transaction((tx) => {
    const live = tx.queryOne(`SELECT id,current_version_id FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [module.id, ctx.userId]);
    if (!live) throw new ApiError("模块不存在", 404);
    tx.query(
      `UPDATE ui_modules SET deleted_at=$1,deleted_by=$2,updated_at=$1 WHERE id=$3 AND owner_user_id=$2`,
      [now, ctx.userId, live.id],
    );
    tx.query(
      `UPDATE ui_module_skill_bindings SET deleted_at=$1,deleted_by=$2,updated_at=$1
        WHERE module_id=$3 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [now, ctx.userId, live.id],
    );
    tx.query(
      `UPDATE ui_module_skill_sessions SET deleted_at=$1,deleted_by=$2,updated_at=$1
        WHERE module_id=$3 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [now, ctx.userId, live.id],
    );
    tx.query(
      `UPDATE ui_module_skill_exports SET deleted_at=$1,deleted_by=$2,updated_at=$1
        WHERE module_id=$3 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [now, ctx.userId, live.id],
    );
    tx.query(`UPDATE ui_module_registry_meta SET revision=revision+1,updated_at=$1 WHERE id='global'`, [now]);
    writeEventSync(tx, ctx, { module_id: live.id, version_id: live.current_version_id, event_type: "module.deleted" }, now);
  });
  return { deleted: true, module_id: module.id };
}

export async function bindProvider(ctx, moduleId, providerAlias, body = {}) {
  const module = await ownedModule(ctx, moduleId);
  if (typeof ctx.transaction !== "function") throw new ApiError("当前数据库不支持 Provider 绑定事务", 500);
  const alias = String(providerAlias || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(alias)) throw new ApiError("Provider 别名不合法", 400);
  if (body.provider_type !== "mcp") throw new ApiError("当前只支持 mcp Provider", 400);
  const provider = await ctx.queryOne(
    `SELECT id,provider_name,is_active FROM app_mcp_providers WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [body.provider_id],
  );
  if (!provider) throw new ApiError("MCP Provider 不存在", 404);
  if (!bool(provider.is_active)) throw new ApiError("MCP Provider 已停用", 409);
  const rawReadTools = Array.isArray(body.config?.read_tools) ? body.config.read_tools : [];
  const readTools = [...new Set(rawReadTools.map((item) => String(item || "").trim()).filter(Boolean))];
  if (readTools.length > 100 || readTools.some((item) => item.length > 200)) {
    throw new ApiError("Provider 只读工具清单最多 100 项，每项不超过 200 个字符", 400);
  }
  const bindingConfig = { ...(body.config && typeof body.config === "object" ? body.config : {}), read_tools: readTools };
  const now = new Date().toISOString();
  ctx.transaction((tx) => {
    const live = tx.queryOne(`SELECT id,current_version_id FROM ui_modules WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [module.id, ctx.userId]);
    if (!live) throw new ApiError("模块不存在", 404);
    const existing = tx.queryOne(
      `SELECT id FROM ui_module_provider_bindings WHERE module_id=$1 AND provider_alias=$2 AND deleted_at IS NULL`,
      [live.id, alias],
    );
    if (existing) {
      tx.query(
        `UPDATE ui_module_provider_bindings SET provider_type='mcp',provider_id=$1,config_json=$2,enabled=1,
           updated_by=$3,updated_at=$4 WHERE id=$5 AND module_id=$6`,
        [provider.id, bindingConfig, ctx.userId, now, existing.id, live.id],
      );
    } else {
      tx.query(
        `INSERT INTO ui_module_provider_bindings
           (id,module_id,provider_alias,provider_type,provider_id,config_json,enabled,created_by,updated_by,created_at,updated_at)
         VALUES ($1,$2,$3,'mcp',$4,$5,1,$6,$6,$7,$7)`,
        [randomUUID(), live.id, alias, provider.id, bindingConfig, ctx.userId, now],
      );
    }
    writeEventSync(tx, ctx, {
      module_id: live.id,
      version_id: live.current_version_id,
      event_type: "provider.bound",
      detail: { provider_alias: alias, provider_id: provider.id },
    }, now);
  });
  return { module_id: module.id, provider_alias: alias, provider_type: "mcp", provider_id: provider.id, ready: true };
}

function resolveActionValue(value, input) {
  if (typeof value !== "string" || !value.startsWith("$input.")) return value;
  return value.slice(7).split(".").reduce((current, key) => current?.[key], input);
}

function resolveActionValueDeep(value, input) {
  if (Array.isArray(value)) return value.map((item) => resolveActionValueDeep(item, input));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveActionValueDeep(item, input)]));
  }
  return resolveActionValue(value, input);
}

function sanitizeActionValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 8) return "[内容层级过深，已省略]";
  if (seen.has(value)) return "[循环引用，已省略]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeActionValue(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [
    key,
    SENSITIVE_OUTPUT_KEY.test(key) ? "[已隐藏]" : sanitizeActionValue(item, depth + 1, seen),
  ]));
}

function boundedActionResult(value) {
  const sanitized = sanitizeActionValue(value);
  const serialized = JSON.stringify(sanitized ?? null);
  if (Buffer.byteLength(serialized) <= MAX_ACTION_OUTPUT_TEXT) return sanitized ?? null;
  const bytes = Buffer.from(serialized);
  const text = bytes.subarray(0, MAX_ACTION_OUTPUT_TEXT - 64).toString("utf8").replace(/\uFFFD$/, "");
  return { truncated: true, text };
}

function mcpResultData(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (Array.isArray(result?.content) ? result.content : [])
    .map((item) => item?.type === "text" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, MAX_ACTION_OUTPUT_TEXT) };
  }
}

async function assertPermission(ctx, moduleId, versionId, permission) {
  const grant = await ctx.queryOne(
    `SELECT id FROM ui_module_permission_grants
      WHERE module_id=$1 AND granted_for_version_id=$2 AND permission=$3 AND status='granted' LIMIT 1`,
    [moduleId, versionId, permission],
  );
  if (!grant) throw new ApiError(`模块没有权限 ${permission}`, 403);
}

async function runStateAction(ctx, module, version, action, input) {
  const namespace = String(action.namespace || "default").slice(0, 80);
  const key = String(resolveActionValue(action.key ?? "$input.key", input) || "").slice(0, 200);
  if (!key) throw new ApiError("状态动作缺少 key", 400);
  if (action.type === "state.get") {
    const row = await ctx.queryOne(
      `SELECT value_json,revision FROM ui_module_state
        WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND state_key=$4 AND deleted_at IS NULL LIMIT 1`,
      [module.id, ctx.userId, namespace, key],
    );
    return { key, namespace, value: parseJson(row?.value_json, null), revision: Number(row?.revision || 0) };
  }
  const value = action.value !== undefined ? resolveActionValueDeep(action.value, input) : input.value;
  assertMiniAppStateValue(parseJson(version?.state_schema_json, null), { namespace, key, value });
  const existing = await ctx.queryOne(
    `SELECT id,revision FROM ui_module_state
      WHERE module_id=$1 AND owner_user_id=$2 AND namespace=$3 AND state_key=$4 AND deleted_at IS NULL LIMIT 1`,
    [module.id, ctx.userId, namespace, key],
  );
  if (existing) {
    await ctx.query(
      `UPDATE ui_module_state SET value_json=$1,revision=revision+1,updated_at=now()
        WHERE id=$2 AND module_id=$3 AND owner_user_id=$4`,
      [value, existing.id, module.id, ctx.userId],
    );
    const result = { key, namespace, value, revision: Number(existing.revision || 0) + 1 };
    await writeEvent(ctx, { module_id: module.id, version_id: version.id, event_type: "state.changed", source: "module", detail: result });
    return result;
  }
  await ctx.query(
    `INSERT INTO ui_module_state
       (id,module_id,owner_user_id,namespace,state_key,value_json,revision,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,now(),now())`,
    [randomUUID(), module.id, ctx.userId, namespace, key, value],
  );
  const result = { key, namespace, value, revision: 1 };
  await writeEvent(ctx, { module_id: module.id, version_id: version.id, event_type: "state.changed", source: "module", detail: result });
  return result;
}

async function runProviderAction(ctx, module, action, input) {
  const binding = await ctx.queryOne(
    `SELECT * FROM ui_module_provider_bindings
      WHERE module_id=$1 AND provider_alias=$2 AND enabled=1 AND deleted_at IS NULL LIMIT 1`,
    [module.id, action.provider],
  );
  if (!binding) throw new ApiError(`模块尚未绑定 Provider ${action.provider}`, 409);
  if (binding.provider_type !== "mcp") throw new ApiError(`不支持 Provider 类型 ${binding.provider_type}`, 400);
  const provider = await ctx.queryOne(
    `SELECT * FROM app_mcp_providers WHERE id=$1 AND is_active=1 AND deleted_at IS NULL LIMIT 1`,
    [binding.provider_id],
  );
  if (!provider) throw new ApiError("MCP Provider 不存在或已停用", 409);
  const requestedTimeout = Number(action.timeout_ms || 30_000);
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(60_000, Math.max(1_000, requestedTimeout)) : 30_000;
  const connection = await connectMcpProvider(provider, { timeoutMs });
  try {
    const tools = await listAllMcpTools(connection);
    const tool = tools.find((item) => item.name === action.tool);
    if (!tool) throw new ApiError(`MCP Provider 不存在工具 ${action.tool}`, 409);
    const bindingConfig = parseJson(binding.config_json);
    const explicitlyAllowed = Array.isArray(bindingConfig.read_tools) && bindingConfig.read_tools.includes(action.tool);
    if (tool.annotations?.destructiveHint === true || (!mcpToolIsReadOnly(tool) && !explicitlyAllowed)) {
      throw new ApiError(`MCP 工具 ${action.tool} 未确认是只读工具，动态模块不能自动调用`, 403);
    }
    const args = action.arguments && typeof action.arguments === "object"
      ? resolveActionValueDeep(action.arguments, input)
      : input;
    const result = await connection.client.callTool(
      { name: action.tool, arguments: args || {} },
      undefined,
      { signal: ctx.signal, timeout: connection.timeoutMs, resetTimeoutOnProgress: true, maxTotalTimeout: Math.max(connection.timeoutMs * 3, 60_000) },
    );
    if (result?.isError) throw new ApiError("MCP 工具返回错误", 502);
    return { data: mcpResultData(result), provider_id: provider.id, provider_tool: action.tool };
  } finally {
    await closeMcpConnection(connection).catch(() => {});
  }
}

async function agentIntentBinding(ctx, module, version, actionName, action, input) {
  assertMiniAppCommandInput(input, action.input_schema);
  const manifest = parseJson(version.manifest_json);
  const bindingId = String(manifest.product?.bindingId || "").trim();
  if (!bindingId) throw new ApiError("Agent 小程序缺少 Skill 绑定", 409);
  const binding = await ctx.queryOne(
    `SELECT id,skill_name,project_id FROM ui_module_skill_bindings
      WHERE id=$1 AND module_id=$2 AND version_id=$3 AND owner_user_id=$4
        AND status='installed' AND deleted_at IS NULL LIMIT 1`,
    [bindingId, module.id, version.id, ctx.userId],
  );
  if (!binding) throw new ApiError("Agent 小程序的 Skill 绑定不存在", 409);
  return {
    kind: "agent.intent",
    action_name: actionName,
    command: action.command,
    title: action.title || action.command,
    input,
    binding_id: binding.id,
    project_id: binding.project_id || null,
  };
}

export async function resolveMiniAppAgentCommand(ctx, {
  moduleId,
  versionId,
  actionName,
  requestId,
  input,
} = {}) {
  const module = await ownedModule(ctx, moduleId, { includeDisabled: false });
  if (!versionId || versionId !== module.current_version_id) throw new ApiError("Agent 小程序版本已变化，请刷新页面", 409);
  const version = await ctx.queryOne(
    `SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [versionId, module.id],
  );
  if (!version) throw new ApiError("Agent 小程序版本不存在", 409);
  const normalizedActionName = String(actionName || "").trim();
  const action = parseJson(version.actions_json)[normalizedActionName];
  if (!action || action.type !== "agent.intent") throw new ApiError("Agent 小程序命令不存在", 404);
  const commandRequestId = String(requestId || "").trim();
  if (!commandRequestId) throw new ApiError("Agent 小程序命令缺少已执行的 request_id", 409);
  const actionRun = await ctx.queryOne(
    `SELECT module_id,version_id,action_name,status,input_json FROM ui_module_action_runs
      WHERE request_id=$1 AND owner_user_id=$2 LIMIT 1`,
    [`${ctx.userId}:${commandRequestId}`, ctx.userId],
  );
  if (!actionRun || actionRun.status !== "completed"
    || actionRun.module_id !== module.id || actionRun.version_id !== version.id || actionRun.action_name !== normalizedActionName) {
    throw new ApiError("Agent 小程序命令没有对应的已完成动作记录", 409);
  }
  await assertPermission(ctx, module.id, version.id, action.permission);
  const commandInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (stableJson(parseJson(actionRun.input_json)) !== stableJson(commandInput)) {
    throw new ApiError("Agent 小程序命令输入与动作记录不一致", 409);
  }
  const resolved = await agentIntentBinding(ctx, module, version, normalizedActionName, action, commandInput);
  const serializedInput = JSON.stringify(commandInput);
  return {
    ...resolved,
    intent: action.intent,
    agent_message: [
      `执行 Agent 小程序命令「${action.command}」。`,
      `命令意图：${action.intent}`,
      `结构化输入：${serializedInput}`,
      "请严格按照当前产品绑定的 Skill、工具权限和状态结构完成任务；需要保存产品数据时使用产品状态工具。",
    ].join("\n"),
  };
}

export async function runModuleAction(ctx, moduleId, actionName, body = {}) {
  const module = await ownedModule(ctx, moduleId, { includeDisabled: false });
  const requestId = String(body.request_id || "").trim();
  if (!requestId || requestId.length > 200) throw new ApiError("request_id 必须是 1 到 200 个字符", 400);
  const requestedVersionId = String(body.version_id || "").trim();
  if (!requestedVersionId) throw new ApiError("version_id 为必填项", 400);
  if (requestedVersionId !== module.current_version_id) throw new ApiError("模块版本已变化，请刷新页面", 409);
  const storedRequestId = `${ctx.userId}:${requestId}`;
  const replay = await ctx.queryOne(
    `SELECT * FROM ui_module_action_runs
      WHERE request_id=$1 OR (request_id=$2 AND owner_user_id=$3) ORDER BY created_at DESC LIMIT 1`,
    [storedRequestId, requestId, ctx.userId],
  );
  if (replay) {
    if (replay.module_id !== module.id || replay.version_id !== requestedVersionId || replay.action_name !== actionName) {
      throw new ApiError("request_id 已用于其他模块动作或版本", 409);
    }
    if (replay.status === "completed") return { request_id: requestId, status: "completed", data: parseJson(replay.output_summary_json, null), idempotent_replay: true };
    if (replay.status === "running") throw new ApiError("相同动作正在执行", 409);
  }
  const version = await ctx.queryOne(`SELECT * FROM ui_module_versions WHERE id=$1 AND module_id=$2 AND deleted_at IS NULL`, [module.current_version_id, module.id]);
  if (!version) throw new ApiError("模块当前版本不存在", 409);
  const actions = parseJson(version?.actions_json);
  const action = actions[actionName];
  if (!action) throw new ApiError(`模块动作不存在: ${actionName}`, 404);
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_ACTION_INPUT_BYTES) throw new ApiError("模块动作输入过大", 400);
  await assertPermission(ctx, module.id, version.id, action.permission);
  const runId = replay?.id || randomUUID();
  if (replay) {
    await ctx.query(`UPDATE ui_module_action_runs SET status='running',input_json=$1,error_code=NULL,error_message=NULL,started_at=now(),updated_at=now() WHERE id=$2`, [input, runId]);
  } else {
    await ctx.query(
      `INSERT INTO ui_module_action_runs
         (id,request_id,module_id,version_id,action_name,owner_user_id,status,input_json,permission,started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,now(),now(),now())`,
      [runId, storedRequestId, module.id, version.id, actionName, ctx.userId, input, action.permission],
    );
  }
  try {
    let result;
    let provider = {};
    if (action.type === "state.get" || action.type === "state.set") result = await runStateAction(ctx, module, version, action, input);
    else if (action.type === "provider.call") {
      const providerResult = await runProviderAction(ctx, module, action, input);
      result = providerResult.data;
      provider = providerResult;
    } else if (action.type === "agent.intent") {
      result = await agentIntentBinding(ctx, module, version, actionName, action, input);
    } else throw new ApiError(`不支持模块动作类型 ${action.type}`, 400);
    const safeResult = boundedActionResult(result);
    await ctx.query(
      `UPDATE ui_module_action_runs SET status='completed',output_summary_json=$1,provider_type=$2,provider_id=$3,
         provider_tool=$4,finished_at=now(),updated_at=now() WHERE id=$5`,
      [safeResult, action.type === "provider.call" ? "mcp" : null, provider.provider_id || null, provider.provider_tool || null, runId],
    );
    return {
      request_id: requestId,
      status: "completed",
      data: safeResult,
      state_patch: action.type === "state.set" ? [safeResult] : [],
      events: action.type === "state.set" ? [{ type: "state.changed", ...safeResult }] : [],
    };
  } catch (error) {
    await ctx.query(
      `UPDATE ui_module_action_runs SET status='failed',error_code=$1,error_message=$2,finished_at=now(),updated_at=now() WHERE id=$3`,
      [error?.code || error?.status || "MODULE_ACTION_FAILED", String(error?.message || error).slice(0, 2000), runId],
    ).catch(() => {});
    throw error;
  }
}
