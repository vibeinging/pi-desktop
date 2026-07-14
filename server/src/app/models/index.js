import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';
import { invalidateModelConfigCache } from '../../engine/core/llm.js';
import {
  deleteCredential,
  isCredentialRef,
  resolveCredential,
  storeModelCredential,
} from '../../credentials.js';

const CATEGORIES = new Set(['PRIMARY', 'SECONDARY', 'EMBEDDING']);
const FORMATS = new Set(['anthropic', 'chat_completions', 'responses']);

function normalizeBody(body = {}) {
  const category = String(body.category || 'PRIMARY').toUpperCase();
  if (!CATEGORIES.has(category)) throw new ApiError('无效的模型类别');
  const modelName = String(body.model_name || '').trim();
  const apiBase = String(body.api_base || '').trim();
  if (!modelName || !apiBase) throw new ApiError('模型名称和 API 地址不能为空');
  return {
    modelName,
    displayName: String(body.display_name || modelName),
    category,
    apiBase,
    apiKey: body.api_key == null ? null : String(body.api_key),
    apiFormat: FORMATS.has(body.api_format) ? body.api_format : 'chat_completions',
    extraConfig: typeof body.extra_config === 'string' ? body.extra_config : JSON.stringify(body.extra_config || {}),
    projectId: body.project_id || null,
    isEnabled: ![false, 0, '0', 'false'].includes(body.is_enabled),
  };
}

function listShape(items) {
  return { items: items.map((item) => ({ ...item, api_key: item.api_key ? '********' : '' })), total: items.length };
}

function detailShape(item) {
  return { ...item, api_key: item.api_key ? '********' : '' };
}

export async function listModels(ctx, input) {
  const params = [];
  let sql = 'SELECT * FROM llm_models WHERE deleted_at IS NULL';
  if (input.query?.category) { params.push(String(input.query.category).toUpperCase()); sql += ` AND category=$${params.length}`; }
  sql += ' ORDER BY created_at DESC';
  return listShape(await ctx.query(sql, params));
}

export async function listActiveModels(ctx, input) {
  const params = [];
  let sql = 'SELECT * FROM llm_models WHERE deleted_at IS NULL AND is_enabled=1';
  if (input.query?.category) { params.push(String(input.query.category).toUpperCase()); sql += ` AND category=$${params.length}`; }
  return listShape(await ctx.query(`${sql} ORDER BY created_at DESC`, params));
}

export async function getModelDetail(ctx, input) {
  const row = await ctx.queryOne('SELECT * FROM llm_models WHERE id=$1 AND deleted_at IS NULL', [input.query?.model_id]);
  if (!row) throw new ApiError('模型不存在', 404);
  return detailShape(row);
}

export async function createModel(ctx, input) {
  const model = normalizeBody(input.body);
  const existing = await ctx.queryOne('SELECT id FROM llm_models WHERE category=$1 AND project_id IS $2 AND deleted_at IS NULL', [model.category, model.projectId]);
  if (existing) throw new ApiError('该角色已有模型，请先编辑或删除');
  const id = randomUUID();
  const credentialRef = model.apiKey ? await storeModelCredential(id, model.apiKey) : null;
  try {
    await ctx.query(
      `INSERT INTO llm_models
        (id,model_name,display_name,category,api_base,api_key,api_format,is_enabled,extra_config,project_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, model.modelName, model.displayName, model.category, model.apiBase, credentialRef, model.apiFormat, model.isEnabled ? 1 : 0, model.extraConfig, model.projectId],
    );
  } catch (error) {
    if (credentialRef) await deleteCredential(credentialRef).catch(() => {});
    throw error;
  }
  invalidateModelConfigCache();
  return getModelDetail(ctx, { query: { model_id: id } });
}

export async function updateModel(ctx, input) {
  const id = input.body?.id || input.body?.model_id;
  const current = await ctx.queryOne('SELECT * FROM llm_models WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!current) throw new ApiError('模型不存在', 404);
  const hasNewSecret = Object.prototype.hasOwnProperty.call(input.body || {}, 'api_key')
    && !String(input.body?.api_key || '').includes('****');
  let credentialRef = current.api_key;
  let createdRef = null;
  if (hasNewSecret) {
    const nextSecret = String(input.body?.api_key || '');
    createdRef = nextSecret ? await storeModelCredential(id, nextSecret) : null;
    credentialRef = createdRef;
  }
  const merged = normalizeBody({ ...current, ...input.body, api_key: credentialRef });
  try {
    await ctx.query(
      `UPDATE llm_models SET model_name=$1,display_name=$2,category=$3,api_base=$4,api_key=$5,
        api_format=$6,extra_config=$7,is_enabled=$8,updated_at=CURRENT_TIMESTAMP WHERE id=$9`,
      [merged.modelName, merged.displayName, merged.category, merged.apiBase, credentialRef, merged.apiFormat, merged.extraConfig, merged.isEnabled ? 1 : 0, id],
    );
  } catch (error) {
    if (createdRef) await deleteCredential(createdRef).catch(() => {});
    throw error;
  }
  if (hasNewSecret && isCredentialRef(current.api_key) && current.api_key !== credentialRef) {
    await deleteCredential(current.api_key).catch(() => {});
  }
  invalidateModelConfigCache();
  return getModelDetail(ctx, { query: { model_id: id } });
}

export async function deleteModel(ctx, input) {
  const id = input.body?.model_id || input.params?.modelId;
  const current = await ctx.queryOne('SELECT api_key FROM llm_models WHERE id=$1 AND deleted_at IS NULL', [id]);
  await ctx.query('UPDATE llm_models SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [id]);
  if (isCredentialRef(current?.api_key)) await deleteCredential(current.api_key).catch(() => {});
  invalidateModelConfigCache();
  return null;
}

export async function testModelConfig(_ctx, input) {
  const config = normalizeBody(input.body);
  config.apiKey = await resolveCredential(config.apiKey);
  const base = config.apiBase.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let url = `${base}/chat/completions`;
  let body = { model: config.modelName, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 };
  if (config.apiFormat === 'responses') {
    url = `${base}/responses`;
    body = { model: config.modelName, input: 'Hello', max_output_tokens: 8 };
  } else if (config.apiFormat === 'anthropic') {
    url = `${base}/messages`;
    delete headers.authorization;
    headers['x-api-key'] = config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    body = { model: config.modelName, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 };
  }
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { success: false, message: `连接失败: HTTP ${response.status}` };
    return { success: true, message: '连接成功', model: config.modelName };
  } catch (error) {
    return { success: false, message: `连接失败: ${error?.message || error}` };
  }
}

export async function listProjectModels(ctx, input) {
  const items = await ctx.query('SELECT * FROM llm_models WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [input.params.pid]);
  return listShape(items);
}

export const createProjectModel = (ctx, input) => createModel(ctx, { ...input, body: { ...input.body, project_id: input.params.pid } });
export const updateProjectModel = updateModel;
export const deleteProjectModel = deleteModel;
