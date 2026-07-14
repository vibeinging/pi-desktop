import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from './generated/app-config.js';

const REF_PREFIX = 'credential:';
const pending = new Map();
let provider = null;
let migrationState = { status: 'not_started', migrated: 0, errors: [] };

process.on('message', (message) => {
  if (message?.type !== 'credential-response' || !message.requestId) return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new Error(message.error || '系统凭据操作失败'));
});

export function isCredentialRef(value) {
  return typeof value === 'string' && value.startsWith(REF_PREFIX);
}

export function setCredentialProvider(nextProvider) {
  provider = nextProvider || null;
}

async function requestCredential(action, ref, value) {
  if (provider) return provider[action](ref, value);
  if (typeof process.send !== 'function') throw new Error(`系统凭据存储仅在 ${APP_CONFIG.productName} 中可用`);
  const requestId = `credential-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('系统凭据操作超时'));
    }, 10_000);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: 'credential-request', requestId, action, ref, value });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

export const getCredential = (ref) => requestCredential('get', ref);
export const setCredential = (ref, value) => requestCredential('set', ref, String(value ?? ''));
export const deleteCredential = (ref) => requestCredential('delete', ref);

export async function resolveCredential(value) {
  if (!isCredentialRef(value)) return value;
  const secret = await getCredential(value);
  if (secret === null || secret === undefined) throw new Error(`系统凭据不存在: ${value}`);
  return secret;
}

export async function resolveCredentialMap(values = {}) {
  return Object.fromEntries(await Promise.all(
    Object.entries(values || {}).map(async ([key, value]) => [key, await resolveCredential(value)]),
  ));
}

function newRef(scope, owner, key = '') {
  const parts = [REF_PREFIX.slice(0, -1), scope, owner, key, randomUUID()].filter(Boolean);
  return parts.join(':');
}

export async function storeModelCredential(modelId, secret) {
  const ref = newRef('model', modelId);
  await setCredential(ref, secret);
  return ref;
}

export async function storeMcpCredentials(providerName, values = {}) {
  const secured = {};
  const createdRefs = [];
  try {
    for (const [key, rawValue] of Object.entries(values || {})) {
      const value = String(rawValue ?? '');
      if (!value || isCredentialRef(value)) {
        secured[key] = value;
        continue;
      }
      const encodedKey = Buffer.from(key).toString('base64url');
      const ref = newRef('mcp', providerName, encodedKey);
      await setCredential(ref, value);
      secured[key] = ref;
      createdRefs.push(ref);
    }
    return { values: secured, createdRefs };
  } catch (error) {
    await Promise.allSettled(createdRefs.map((ref) => deleteCredential(ref)));
    throw error;
  }
}

export async function deleteCredentialRefs(values) {
  const refs = (Array.isArray(values) ? values : Object.values(values || {})).filter(isCredentialRef);
  await Promise.allSettled(refs.map((ref) => deleteCredential(ref)));
}

export function getCredentialMigrationState() {
  return { ...migrationState, errors: [...migrationState.errors] };
}

export async function migrateLegacyCredentials({ query }) {
  migrationState = { status: 'running', migrated: 0, errors: [] };
  const errors = [];
  let migrated = 0;
  const models = await query(
    `SELECT id,api_key FROM llm_models
      WHERE api_key IS NOT NULL AND api_key<>'' AND api_key NOT LIKE 'credential:%'`,
  );
  for (const model of models) {
    let ref;
    try {
      ref = await storeModelCredential(model.id, model.api_key);
      const result = await query(
        `UPDATE llm_models SET api_key=$1,updated_at=CURRENT_TIMESTAMP
          WHERE id=$2 AND api_key=$3`,
        [ref, model.id, model.api_key],
      );
      if (result.rowCount !== 1) throw new Error('模型密钥记录已变化');
      migrated += 1;
    } catch (error) {
      if (ref) await deleteCredential(ref).catch(() => {});
      errors.push(`model:${model.id}: ${error?.message || error}`);
    }
  }

  const providers = await query(
    `SELECT id,provider_name,env FROM app_mcp_providers
      WHERE deleted_at IS NULL AND env IS NOT NULL AND env<>''`,
  );
  for (const row of providers) {
    let env;
    try { env = JSON.parse(row.env || '{}'); } catch { continue; }
    const plainEntries = Object.entries(env).filter(([, value]) => value && !isCredentialRef(value));
    if (!plainEntries.length) continue;
    let secured;
    try {
      secured = await storeMcpCredentials(row.provider_name, env);
      const result = await query(
        `UPDATE app_mcp_providers SET env=$1,updated_at=CURRENT_TIMESTAMP
          WHERE id=$2 AND env=$3`,
        [JSON.stringify(secured.values), row.id, row.env],
      );
      if (result.rowCount !== 1) throw new Error('MCP 密钥记录已变化');
      migrated += plainEntries.length;
    } catch (error) {
      if (secured) await deleteCredentialRefs(secured.createdRefs);
      errors.push(`mcp:${row.provider_name}: ${error?.message || error}`);
    }
  }
  migrationState = { status: errors.length ? 'partial' : 'complete', migrated, errors };
  return getCredentialMigrationState();
}
