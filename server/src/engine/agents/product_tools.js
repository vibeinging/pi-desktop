import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { PRODUCT_TOOL_CATALOG } from "./product_tool_catalog.js";
import {
  boundedCapabilityResult,
  buildCapabilityCatalog,
  describeCapability,
  findCapability,
  resolveCapabilityProjectScope,
  searchCapabilities,
  validateCapabilityInput,
} from "./capability_bridge.js";
import { claimCapabilityInvocation, completeCapabilityInvocation, failCapabilityInvocation } from "./capability_idempotency.js";
import { hasExplicitProjectCreateRequest, hasExplicitProjectSessionMoveRequest } from "./product_tool_intent.js";
import { listProjects, getProject, createProject } from "../../app/projects/index.js";
import { moveSession } from "../../app/session/index.js";
import { createStructuredDatasource, createUnstructuredDatasource } from "../../app/datasource/datasources.js";
import { uploadDbFile, createDatabase, syncSchema } from "../../app/datasource/connections.js";
import { batchSyncExampleValues } from "../../app/datasource/tables.js";
import { createStructuredDocuments, processStructuredDocuments, listStructuredDocuments } from "../../app/docs/structured.js";
import { createDocument, listDocuments } from "../../app/docs/unstructured.js";
import { getBackgroundJob, latestResourceJob } from "../jobs/background_jobs.js";
import { listDatabases, listTables, listColumns } from "../../app/reads/reads_datasource.js";
import { DatabaseDataSource } from "../datasources/database_data_source.js";
import {
  createAppSkill,
  deleteAppSkill,
  getAppSkill,
  listAppSkills,
  listPiSkills,
  setAppSkillEnabled,
  setPiSkillEnabled,
  updateAppSkill,
} from "./pi_skill_registry.js";
import { downloadRemoteSkill, searchRemoteSkills } from "../skills/remote_skill_registry.js";
import {
  SKILL_PRODUCT_STATE_GET_TOOL,
  SKILL_PRODUCT_STATE_SET_TOOL,
} from "../modules/skill_product_state.js";
import {
  createAppMcpProvider,
  deleteAppMcpProvider,
  deleteMcpProvider,
  listAppMcpProviders,
  listProjectMcpProviders,
  rediscoverAppMcpProvider,
  testAppMcpProvider,
  toggleAppMcpProvider,
  updateAppMcpProvider,
  updateMcpProvider,
} from "../../app/integrations/mcp.js";
import {
  activateVersion,
  createMiniAppSkillExportDraft,
  createDraft,
  createSkillProductDraft,
  getDraft,
  getModule,
  installDraft,
  listMiniAppAgentSkills,
  listModules,
  openMiniApp,
  previewDraft,
  publishMiniAppSkillExport,
  setModuleStatus,
  suspendMiniAppSkillExport,
  useMiniAppAgentSkill,
  validateDraft,
  validateMiniAppSkillExport,
} from "../modules/module_registry.js";

const DB_EXTS = new Set([".db", ".sqlite", ".sqlite3", ".duckdb"]);
const STRUCTURED_EXTS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".json", ".jsonl", ".ndjson", ".parquet", ".pq"]);
const UNSTRUCTURED_EXTS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".html", ".htm"]);
const MAX_SCAN_FILES = 500;
let capabilityCatalogPromise = null;

async function capabilityCatalog() {
  if (!capabilityCatalogPromise) {
    capabilityCatalogPromise = import("../../transport/registry.js")
      .then(({ ROUTES }) => buildCapabilityCatalog(ROUTES));
  }
  return capabilityCatalogPromise;
}

function toolResult(data) {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], details: data };
}

function errorResult(message, extra = {}) {
  return toolResult({ success: false, error: String(message || "工具执行失败"), ...extra });
}

function makeCtx(agentContext) {
  const db = agentContext?.db || {};
  return {
    query: db.query,
    queryOne: db.queryOne,
    transaction: db.transaction,
    userId: agentContext?.user_id || "",
    signal: agentContext?.signal,
  };
}

function projectId(agentContext, params = {}) {
  const explicit = String(params?.project_id || "").trim();
  if (explicit) return explicit;
  const current = String(agentContext?.project_id || "");
  if (current && current !== "__chat__" && !current.startsWith("folder:")) return current;
  return "";
}

function input(params = {}, { pid = "" } = {}) {
  return {
    params: { ...(pid ? { pid } : {}), ...(params.params || {}) },
    body: params.body || {},
    query: params.query || {},
  };
}

function normalizePaths(value) {
  const normalize = (item) => {
    const text = String(item || "").trim();
    if (!text) return "";
    if (text === "~") return homedir();
    if (text.startsWith("~/")) return join(homedir(), text.slice(2));
    return text;
  };
  if (Array.isArray(value)) return value.map(normalize).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [normalize(value)];
  return [];
}

function walkPath(p, recursive, out) {
  if (out.length >= MAX_SCAN_FILES) return;
  if (!existsSync(p)) {
    out.push({ path: p, exists: false, kind: "missing", ext: extname(p).toLowerCase() });
    return;
  }
  const st = statSync(p);
  if (st.isDirectory()) {
    if (!recursive) {
      out.push({ path: p, exists: true, kind: "directory", ext: "" });
      return;
    }
    for (const name of readdirSync(p)) {
      if (out.length >= MAX_SCAN_FILES) break;
      if (name.startsWith(".")) continue;
      walkPath(join(p, name), recursive, out);
    }
    return;
  }
  if (st.isFile()) {
    out.push({ path: p, exists: true, kind: "file", ext: extname(p).toLowerCase(), size: st.size, name: basename(p) });
  }
}

function classifyFiles(paths, recursive = false) {
  const files = [];
  for (const p of paths) walkPath(p, recursive, files);
  const groups = {
    database_files: [],
    structured_files: [],
    unstructured_docs: [],
    unsupported: [],
    missing: [],
    directories: [],
  };
  for (const f of files) {
    if (!f.exists) groups.missing.push(f);
    else if (f.kind === "directory") groups.directories.push(f);
    else if (DB_EXTS.has(f.ext)) groups.database_files.push(f);
    else if (STRUCTURED_EXTS.has(f.ext)) groups.structured_files.push(f);
    else if (UNSTRUCTURED_EXTS.has(f.ext)) groups.unstructured_docs.push(f);
    else groups.unsupported.push(f);
  }
  return { files, groups };
}

function dbTypeForPath(filePath) {
  const ext = extname(String(filePath || "")).toLowerCase();
  if (ext === ".duckdb") return "DuckDB";
  if (DB_EXTS.has(ext)) return "SQLite";
  return "";
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    return fallback ?? { warning: e?.message || String(e) };
  }
}

async function tableSummary(ctx, pid, connId) {
  const tablesResp = await listTables(ctx, input({ params: { cid: connId } }, { pid }));
  const tables = tablesResp?.data?.items || [];
  let columnCount = 0;
  for (const t of tables.slice(0, 50)) {
    const cols = await safeCall(() => listColumns(ctx, input({ params: { cid: connId, tid: t.id } }, { pid })), { data: { items: [] } });
    columnCount += Number(cols?.data?.items?.length || 0);
  }
  return {
    tables: tables.map((t) => ({ id: t.id, name: t.table_name || t.name, schema: t.schema_name, row_count: t.row_count })).slice(0, 100),
    table_count: tables.length,
    column_count: columnCount,
  };
}

async function projectListTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await listProjects(ctx, { query: { search: params.search || "" }, body: {}, params: {} });
  return toolResult({ success: true, ...r.data });
}

async function projectDetailTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const rawId = String(params.project_id || params.id || "").trim();
  const name = String(params.name || params.project_name || "").trim();
  const fallbackId = projectId(agentContext, params);
  const id = rawId || (!name ? fallbackId : "");
  if (id) {
    const r = await getProject(ctx, { params: { id }, query: {}, body: {} });
    return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
  }
  if (!name) return errorResult("project_id/id 或 name 为必填项;也可以在项目会话中省略以查看当前项目。");
  const listed = await listProjects(ctx, { query: { search: name }, body: {}, params: {} });
  const items = listed?.data?.items || [];
  const exact = items.filter((item) => String(item.name || item.project_name || "") === name);
  const matches = exact.length ? exact : items;
  if (matches.length === 1) {
    const foundId = matches[0].id || matches[0].project_id;
    const r = await getProject(ctx, { params: { id: foundId }, query: {}, body: {} });
    return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
  }
  if (!matches.length) return errorResult(`没有找到名为 ${name} 的项目。`, { candidates: [] });
  return errorResult(`找到多个匹配 ${name} 的项目,请提供 project_id。`, {
    candidates: matches.map((item) => ({ id: item.id || item.project_id, name: item.name || item.project_name })),
  });
}

async function projectCreateTool(agentContext, params = {}) {
  const name = String(params.name || "").trim();
  if (!name) return errorResult("name 为必填项");
  if (!hasExplicitProjectCreateRequest(agentContext)) {
    return errorResult("只有用户在本轮消息中明确要求创建、新建、重建、转成或升级为智能问数项目/工作区时,才能创建项目。请先询问用户,并让用户明确回复要创建智能问数项目。", {
      code: "PROJECT_CREATE_REQUIRES_EXPLICIT_USER_REQUEST",
    });
  }
  const ctx = makeCtx(agentContext);
  const r = await createProject(ctx, { body: { name, description: params.description || "" }, params: {}, query: {} });
  return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
}

async function projectSessionMoveTool(agentContext, params = {}) {
  const sid = String(params.session_id || agentContext?.session_id || agentContext?.input_data?.session_id || "").trim();
  if (!sid) return errorResult("缺少 session_id。只有已有会话才能迁移到问数项目。");
  if (!hasExplicitProjectSessionMoveRequest(agentContext)) {
    return errorResult("只有用户本轮明确要求把当前会话迁移、移动或转到已有、现有、指定或具名问数项目/工作区时,才能调用 project_session_move。泛泛说转到智能问数应创建新项目;普通文件分析、发票统计、导入或确认卡都不能自动迁移当前对话。", {
      code: "PROJECT_SESSION_MOVE_REQUIRES_EXPLICIT_USER_REQUEST",
    });
  }
  const fromProjectId = String(params.from_project_id || agentContext?.project_id || "").trim();
  if (!fromProjectId) return errorResult("缺少当前工作区 ID,无法迁移会话。");
  const targetProjectId = String(params.target_project_id || params.project_id || "").trim();
  if (!targetProjectId) return errorResult("target_project_id 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await moveSession(ctx, {
    params: { pid: fromProjectId, sid },
    body: { target_project_id: targetProjectId },
  });
  return toolResult({
    success: true,
    project_id: targetProjectId,
    target_project_id: targetProjectId,
    from_project_id: fromProjectId,
    session_id: sid,
    migrated: r?.data?.migrated !== false,
    session: r?.data?.session || null,
    workspace: r?.data?.workspace || null,
  });
}

async function fileClassifyTool(_agentContext, params = {}) {
  const paths = normalizePaths(params.paths || params.path);
  if (!paths.length) return errorResult("paths 不能为空");
  const recursive = params.recursive !== false;
  const { files, groups } = classifyFiles(paths, recursive);
  return toolResult({
    success: true,
    scanned_count: files.length,
    truncated: files.length >= MAX_SCAN_FILES,
    groups,
  });
}

async function structuredImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const paths = normalizePaths(params.file_paths || params.paths || params.path);
  if (!paths.length) return errorResult("file_paths 不能为空");
  const ctx = makeCtx(agentContext);
  const dsName = String(params.data_source_name || params.name || `structured-${Date.now()}`).trim();
  const ds = await createStructuredDatasource(ctx, input({ body: { name: dsName, description: params.description || "" } }, { pid }));
  const dsid = ds?.data?.id;
  const created = await createStructuredDocuments(ctx, input({ body: { data_source_id: dsid, file_paths: paths } }, { pid }));
  const documentIds = (created?.data?.created_documents || []).map((d) => d.document_id).filter(Boolean);
  const processed = await processStructuredDocuments(
    ctx,
    input({ body: {
      data_source_id: dsid,
      ...(documentIds.length ? { document_ids: documentIds } : {}),
      session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
    } }, { pid }),
  );
  const connId = processed?.data?.database_connection_id;
  const docs = await safeCall(
    () => listStructuredDocuments(ctx, { params: { pid }, query: { data_source_id: dsid }, body: {} }),
    { data: { items: [] } },
  );
  const summary = connId ? await tableSummary(ctx, pid, connId) : {};
  return toolResult({
    success: true,
    project_id: pid,
    data_source_id: dsid,
    connection_id: connId,
    processed: processed?.data?.processed || [],
    jobs: processed?.data?.job ? [processed.data.job] : [],
    documents: docs?.data?.items || [],
    ...summary,
  });
}

async function databaseFileImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const filePath = String(params.file_path || params.path || "").trim();
  if (!filePath) return errorResult("file_path 为必填项");
  const dbType = params.db_type || dbTypeForPath(filePath);
  if (!dbType) return errorResult("无法从文件扩展名识别数据库类型,仅支持 SQLite/DuckDB 文件");
  const ctx = makeCtx(agentContext);
  const uploaded = await uploadDbFile(ctx, input({ body: { file_path: filePath } }, { pid }));
  const databasePath = uploaded?.data?.path || filePath;
  const stem = String(params.name || basename(filePath).replace(/\.[^.]+$/, "") || `db-${Date.now()}`);
  const conn = await createDatabase(
    ctx,
    input({
      body: {
        name: stem,
        db_type: dbType,
        host: databasePath,
        database: databasePath,
        description: params.description || `AI 导入数据库文件 ${basename(filePath)}`,
      },
    }, { pid }),
  );
  const connId = conn?.data?.id;
  const synced = await syncSchema(ctx, input({
    params: { cid: connId },
    body: { session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null },
  }, { pid }));
  const warnings = [];
  const jobs = synced?.data?.job ? [synced.data.job] : [];
  const summary = await tableSummary(ctx, pid, connId);
  const tableIds = summary.tables.map((t) => t.id).filter(Boolean);
  if (params.enrich === true && tableIds.length) {
    const samples = await safeCall(() => batchSyncExampleValues(ctx, input({ params: { cid: connId }, body: { table_ids: tableIds, limit: 3 } }, { pid })));
    if (samples?.warning) warnings.push(samples.warning);
  }
  return toolResult({
    success: true,
    project_id: pid,
    connection_id: connId,
    database: conn?.data,
    sync: synced?.data,
    jobs,
    warnings,
    ...summary,
  });
}

async function unstructuredImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const paths = normalizePaths(params.file_paths || params.paths || params.path);
  if (!paths.length) return errorResult("file_paths 不能为空");
  const ctx = makeCtx(agentContext);
  const dsName = String(params.data_source_name || params.name || `docs-${Date.now()}`).trim();
  const ds = await createUnstructuredDatasource(ctx, input({ body: { name: dsName, description: params.description || "" } }, { pid }));
  const dsid = ds?.data?.id;
  const documents = [];
  const jobs = [];
  for (const filePath of paths) {
    const created = await createDocument(ctx, input({
      params: { dsid },
      body: { file_path: filePath, session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null },
    }, { pid }));
    if (created?.data?.document) documents.push(created.data.document);
    if (created?.data?.job) jobs.push(created.data.job);
  }
  const status = await safeCall(
    () => listDocuments(ctx, { params: { pid, dsid }, body: {}, query: {} }),
    { data: { items: [] } },
  );
  return toolResult({
    success: true,
    project_id: pid,
    data_source_id: dsid,
    submitted_count: documents.length,
    documents: status?.data?.items || documents,
    jobs,
    status: "processing",
  });
}

async function jobStatusTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id");
  const ctx = makeCtx(agentContext);
  if (params.job_id) {
    const job = getBackgroundJob(String(params.job_id));
    if (!job || (pid && job.project_id !== pid)) return errorResult("后台任务不存在或不属于当前项目");
    return toolResult({ success: true, project_id: job.project_id, kind: job.kind, ...job });
  }
  const kind = String(params.kind || "").toLowerCase();
  if (params.connection_id || kind === "database") {
    const connId = params.connection_id || params.conn_id;
    if (!connId) return errorResult("connection_id 不能为空");
    const summary = await tableSummary(ctx, pid, connId);
    const job = latestResourceJob('database_connection', connId);
    const status = !summary.table_count
      ? 'importing'
      : ['queued', 'running', 'retry_wait', 'partial'].includes(job?.status)
        ? 'queryable_raw'
        : job?.status === 'failed'
          ? 'queryable_raw'
          : 'context_ready';
    return toolResult({ success: true, project_id: pid, kind: "database", connection_id: connId, status, preparation_job: job || undefined, ...summary });
  }
  if (params.structured_data_source_id || kind === "structured") {
    const dsid = params.structured_data_source_id || params.data_source_id;
    const docs = await listStructuredDocuments(ctx, { params: { pid }, query: { data_source_id: dsid }, body: {} });
    const items = docs?.data?.items || [];
    const failed = items.filter((d) => /failed/i.test(d.status || ""));
    const completed = items.filter((d) => /completed|done|ready/i.test(d.status || ""));
    const dataSource = await ctx.queryOne(
      `SELECT database_connection_id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [dsid, pid],
    ).catch(() => null);
    const job = dataSource?.database_connection_id
      ? latestResourceJob('database_connection', dataSource.database_connection_id)
      : null;
    const rawReady = items.length > 0 && completed.length === items.length;
    const status = failed.length
      ? 'failed'
      : !rawReady
        ? 'importing'
        : ['queued', 'running', 'retry_wait', 'partial'].includes(job?.status) || job?.status === 'failed'
          ? 'queryable_raw'
          : 'context_ready';
    return toolResult({
      success: true,
      project_id: pid,
      kind: "structured",
      data_source_id: dsid,
      connection_id: dataSource?.database_connection_id || undefined,
      status,
      preparation_job: job || undefined,
      documents: items,
    });
  }
  if (params.unstructured_data_source_id || kind === "unstructured") {
    const dsid = params.unstructured_data_source_id || params.data_source_id;
    const docs = await listDocuments(ctx, { params: { pid, dsid }, query: {}, body: {} });
    const items = docs?.data?.items || [];
    const parseFailed = items.filter((d) => String(d.status || "").toLowerCase() === "failed");
    const ready = items.filter((d) => d.status === "completed" && d.markdown_path);
    const status = parseFailed.length
      ? "failed"
      : items.length > 0 && ready.length === items.length
        ? "context_ready"
        : "importing";
    return toolResult({
      success: true,
      project_id: pid,
      kind: "unstructured",
      data_source_id: dsid,
      status,
      total_count: items.length,
      ready_count: ready.length,
      failed_count: parseFailed.length,
      message: status === "importing"
        ? "文档仍在离线转换为 Markdown；在线问答不会等待或代替该任务处理文件。"
        : undefined,
      documents: items,
    });
  }
  const dbs = await listDatabases(ctx, { params: { pid }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, kind: "project", databases: dbs?.data?.items || [] });
}

async function querySmokeTestTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  const connId = String(params.connection_id || params.conn_id || "").trim();
  if (!pid || !connId) return errorResult("project_id 和 connection_id 为必填项");
  const ctx = makeCtx(agentContext);
  const summary = await tableSummary(ctx, pid, connId);
  const first = summary.tables[0];
  if (!first?.name) return errorResult("没有可测试的表", { project_id: pid, connection_id: connId });
  const ds = new DatabaseDataSource(null, pid, connId);
  const schemaPrefix = first.schema && !["default", "main"].includes(String(first.schema)) ? `"${String(first.schema).replace(/"/g, '""')}".` : "";
  const tableSql = `${schemaPrefix}"${String(first.name).replace(/"/g, '""')}"`;
  const result = await ds.query(`SELECT COUNT(*) AS row_count FROM ${tableSql}`);
  return toolResult({
    success: !!result?.success,
    project_id: pid,
    connection_id: connId,
    table: first.name,
    query: `SELECT COUNT(*) AS row_count FROM ${tableSql}`,
    result: result?.to_dict ? result.to_dict() : result,
  });
}

async function skillListTool(agentContext) {
  const ctx = makeCtx(agentContext);
  const skills = await listAppSkills(ctx);
  return toolResult({ success: true, skills });
}

async function skillRegistrySearchTool(_agentContext, params = {}) {
  const query = String(params.query || params.name || "").trim();
  if (!query) return errorResult("query 为必填项");
  const skills = await searchRemoteSkills(query, { limit: params.limit });
  return toolResult({
    success: true,
    count: skills.length,
    skills,
    next: skills.length
      ? "选择匹配的 source_url，调用 skill_download。下载会再次请求用户确认。"
      : "没有找到匹配项，请让用户提供公开 GitHub SKILL.md 地址。",
  });
}

function productAdapterInstructions(skillName) {
  const namespace = String(skillName || "skill-product").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80) || "skill-product";
  return `\n\n## YiW 小程序运行约定\n\n本段是 YiW 在导入时添加的产品适配，不是原仓库内容。\n\n- 在读取或更新产品数据前，先调用 ${SKILL_PRODUCT_STATE_GET_TOOL}，namespace 使用 \`${namespace}\`，key 固定使用 \`product_data\`。\n- 保存完整结构化产品数据时调用 ${SKILL_PRODUCT_STATE_SET_TOOL}，使用相同 namespace 和 key；更新已有数据必须传入刚读取的 revision。\n- 只有保存工具返回成功后，才能告诉用户数据已经保存。\n- 页面与专属 Agent 会话共享同一份版本隔离数据，不得读写其他小程序的数据。`;
}

async function skillDownloadTool(agentContext, params = {}) {
  const sourceUrl = String(params.source_url || params.url || "").trim();
  if (!sourceUrl) return errorResult("source_url 为必填项，请先调用 skill_registry_search");
  const downloaded = await downloadRemoteSkill(sourceUrl);
  const importedName = String(params.name || downloaded.skill.name || "").trim();
  const enableStorage = params.enable_product_storage === true;
  const allowedTools = enableStorage
    ? [SKILL_PRODUCT_STATE_GET_TOOL, SKILL_PRODUCT_STATE_SET_TOOL]
    : [];
  const instructions = `${downloaded.skill.instructions}${enableStorage ? productAdapterInstructions(importedName) : ""}`;
  const payload = {
    name: importedName,
    description: String(params.description || downloaded.skill.description || `从 ${downloaded.provenance.repository} 导入的 Skill`).trim(),
    instructions,
    category: String(params.category || downloaded.skill.category || "downloaded").trim(),
    tags: [...new Set([
      ...(Array.isArray(downloaded.skill.tags) ? downloaded.skill.tags : []),
      ...(Array.isArray(params.tags) ? params.tags : []),
      "downloaded-skill",
    ])],
    allowed_tools: allowedTools,
    runtime: "prompt",
    side_effect: enableStorage ? "write" : "read",
    requires_project: false,
    default_enabled: true,
    is_active: true,
    provenance: {
      ...downloaded.provenance,
      adapted_for_product: enableStorage,
      adapter_version: enableStorage ? 1 : null,
      warnings: downloaded.warnings,
    },
  };
  let skill;
  try {
    skill = await createAppSkill(makeCtx(agentContext), payload, agentContext?.user_id || "");
  } catch (error) {
    if (error?.status !== 409) throw error;
    const current = await getAppSkill(makeCtx(agentContext), importedName);
    const sameSource = current?.provenance?.sha256 === downloaded.provenance.sha256
      && current?.provenance?.source_url === downloaded.provenance.source_url;
    if (!sameSource && params.replace_existing !== true) throw error;
    skill = await updateAppSkill(makeCtx(agentContext), importedName, payload, agentContext?.user_id || "");
  }
  return toolResult({
    success: true,
    skill,
    source: downloaded.provenance,
    warnings: downloaded.warnings,
    adapted_for_product: enableStorage,
    next: "如果用户要求做成小程序，把返回的 Skill 描述和 instructions 作为 requirements.sources 中的一条 skill 需求来源，调用通用 ui_module_draft_create 生成页面、动作和 MiniApp Package，再检查和预览。不要创建 Skill 运行时绑定。",
  });
}

async function skillCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const skill = await createAppSkill(ctx, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillUpdateTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await updateAppSkill(ctx, name, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillToggleTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const patch = {};
  if (typeof params.is_active === "boolean") patch.is_active = params.is_active;
  if (typeof params.default_enabled === "boolean") patch.default_enabled = params.default_enabled;
  if (typeof params.is_enabled === "boolean") patch.is_enabled = params.is_enabled;
  if (!Object.keys(patch).length) return errorResult("至少需要提供 is_active、default_enabled 或 is_enabled");
  const ctx = makeCtx(agentContext);
  const skill = await setAppSkillEnabled(ctx, name, patch, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillDeleteTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const result = await deleteAppSkill(ctx, name, agentContext?.user_id || "");
  return toolResult({ success: true, ...result });
}

async function projectSkillListTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const ctx = makeCtx(agentContext);
  const skills = await listPiSkills(ctx, pid);
  return toolResult({ success: true, project_id: pid, skills });
}

async function projectSkillSetTool(agentContext, params = {}, enabled) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await setPiSkillEnabled(ctx, pid, name, enabled, agentContext?.user_id || "");
  return toolResult({ success: true, project_id: pid, skill });
}

async function mcpProviderListTool(agentContext) {
  const ctx = makeCtx(agentContext);
  const r = await listAppMcpProviders(ctx);
  return toolResult({ success: true, providers: r.data || [] });
}

async function mcpProviderCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await createAppMcpProvider(ctx, { params: {}, query: {}, body: params });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderUpdateTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await updateAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: params });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderToggleTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const patch = {};
  if (typeof params.is_active === "boolean") patch.is_active = params.is_active;
  if (typeof params.default_enabled === "boolean") patch.default_enabled = params.default_enabled;
  if (typeof params.is_enabled === "boolean") patch.is_enabled = params.is_enabled;
  if (!Object.keys(patch).length) return errorResult("至少需要提供 is_active、default_enabled 或 is_enabled");
  const ctx = makeCtx(agentContext);
  const r = await toggleAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: patch });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderDeleteTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await deleteAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: {} });
  return toolResult({ success: true, ...r.data });
}

async function mcpProviderTestTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await testAppMcpProvider(ctx, { params: {}, query: {}, body: params });
  return toolResult({ success: !!r.data?.ok, ...r.data });
}

async function mcpProviderRediscoverTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await rediscoverAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: {} });
  return toolResult({ success: !!r.data?.ok, provider: r.data, tools: r.data?.tools || [], error: r.data?.error || "" });
}

async function projectMcpProviderListTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const ctx = makeCtx(agentContext);
  const r = await listProjectMcpProviders(ctx, { params: { pid }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, providers: r.data || [] });
}

async function projectMcpProviderSetTool(agentContext, params = {}, enabled) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await updateMcpProvider(ctx, {
    params: { pid, providerName: name },
    query: {},
    body: { enabled_override: enabled },
  });
  return toolResult({ success: true, project_id: pid, provider: r.data });
}

async function projectMcpProviderResetTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await deleteMcpProvider(ctx, { params: { pid, providerName: name }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, provider: r.data });
}

async function uiModuleListTool(agentContext, params = {}) {
  const result = await listModules(makeCtx(agentContext), { status: params.status });
  return toolResult({ success: true, ...result });
}

async function uiModuleGetTool(agentContext, params = {}) {
  const moduleId = String(params.module_id || params.module_key || "").trim();
  if (!moduleId) return errorResult("module_id 或 module_key 为必填项");
  const module = await getModule(makeCtx(agentContext), moduleId);
  return toolResult({ success: true, module_id: module.id, module_key: module.module_key, module });
}

async function uiModuleDraftCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const draft = await createDraft(ctx, {
    ...params,
    source: "agent",
    request_text: params.request_text || agentContext?.input_data?.message || agentContext?.user_message || "",
  });
  return toolResult({
    success: true,
    draft_id: draft.id,
    module_id: draft.module_id,
    module_key: draft.module_key,
    revision: draft.revision,
    draft,
  });
}

async function uiSkillProductDraftCreateTool(agentContext, params = {}) {
  const draft = await createSkillProductDraft(makeCtx(agentContext), {
    ...params,
    project_id: params.project_id || (String(agentContext?.project_id || "").startsWith("__") ? null : agentContext?.project_id),
    request_text: params.request_text || agentContext?.input_data?.user_message || "",
  });
  return toolResult({
    success: true,
    draft_id: draft.id,
    module_id: draft.module_id,
    module_key: draft.module_key,
    revision: draft.revision,
    skill_product: draft.skill_product,
    draft,
    next: "调用 ui_module_draft_preview 预览完整产品；用户确认后再安装。",
  });
}

async function uiModuleDraftValidateTool(agentContext, params = {}) {
  const draftId = String(params.draft_id || "").trim();
  if (!draftId) return errorResult("draft_id 为必填项");
  const result = await validateDraft(makeCtx(agentContext), draftId, { expected_revision: params.expected_revision });
  return toolResult({ success: result.valid, draft_id: draftId, ...result });
}

async function uiModuleDraftPreviewTool(agentContext, params = {}) {
  const draftId = String(params.draft_id || "").trim();
  if (!draftId) return errorResult("draft_id 为必填项");
  const ctx = makeCtx(agentContext);
  const draft = await getDraft(ctx, draftId);
  const preview = await previewDraft(ctx, draftId, {
    expected_revision: params.expected_revision ?? draft.revision,
    validation_hash: params.validation_hash,
  });
  return toolResult({ success: true, ...preview, event: "module_preview_ready" });
}

async function uiModuleDraftInstallTool(agentContext, params = {}) {
  const draftId = String(params.draft_id || "").trim();
  if (!draftId) return errorResult("draft_id 为必填项");
  const expectedRevision = Number(params.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return errorResult("expected_revision 为必填正整数");
  const validationHashValue = String(params.validation_hash || "").trim();
  if (!validationHashValue) return errorResult("validation_hash 为必填项，请先预览模块");
  const previewToken = String(params.preview_token || "").trim();
  if (!previewToken) return errorResult("preview_token 为必填项，请先预览模块");
  const ctx = makeCtx(agentContext);
  const check = await validateDraft(ctx, draftId, { expected_revision: expectedRevision });
  if (!check.valid) return toolResult({ success: false, draft_id: draftId, ...check });
  const decisions = Object.fromEntries(check.new_permissions.map((permission) => [permission, params.grant_permissions === true]));
  const module = await installDraft(ctx, draftId, {
    expected_revision: expectedRevision,
    validation_hash: validationHashValue,
    preview_token: previewToken,
    permission_decisions: params.permission_decisions || decisions,
    idempotency_key: params.idempotency_key,
  });
  return toolResult({
    success: true,
    event: "module_installed",
    module_id: module.id,
    module_key: module.module_key,
    draft_id: draftId,
    module,
  });
}

async function miniAppAgentExportDraftTool(agentContext, params = {}) {
  const moduleId = String(params.module_id || params.module_key || "").trim();
  if (!moduleId) return errorResult("module_id 或 module_key 为必填项");
  const exported = await createMiniAppSkillExportDraft(makeCtx(agentContext), moduleId, params);
  return toolResult({
    success: true,
    export: exported,
    export_id: exported.id,
    next: "调用 miniapp_agent_export_validate 检查；检查通过后，用户确认才能发布。",
  });
}

async function miniAppAgentExportValidateTool(agentContext, params = {}) {
  const exportId = String(params.export_id || "").trim();
  if (!exportId) return errorResult("export_id 为必填项");
  const result = await validateMiniAppSkillExport(makeCtx(agentContext), exportId);
  return toolResult({ success: result.valid, ...result });
}

async function miniAppAgentExportPublishTool(agentContext, params = {}) {
  const exportId = String(params.export_id || "").trim();
  if (!exportId) return errorResult("export_id 为必填项");
  const exported = await publishMiniAppSkillExport(makeCtx(agentContext), exportId, params);
  return toolResult({ success: true, export: exported, export_id: exported.id, status: exported.status });
}

async function miniAppAgentExportSuspendTool(agentContext, params = {}) {
  const exportId = String(params.export_id || "").trim();
  if (!exportId) return errorResult("export_id 为必填项");
  const exported = await suspendMiniAppSkillExport(makeCtx(agentContext), exportId);
  return toolResult({ success: true, export: exported, export_id: exported.id, status: exported.status });
}

async function miniAppListTool(agentContext, params = {}) {
  const result = await listMiniAppAgentSkills(makeCtx(agentContext), { status: params.status || "published" });
  return toolResult({ success: true, ...result });
}

async function miniAppUseTool(agentContext, params = {}) {
  const result = await useMiniAppAgentSkill(makeCtx(agentContext), params);
  return toolResult({ success: true, ...result });
}

async function miniAppOpenTool(agentContext, params = {}) {
  const moduleId = String(params.module_id || params.module_key || "").trim();
  if (!moduleId) return errorResult("module_id 或 module_key 为必填项");
  const result = await openMiniApp(makeCtx(agentContext), moduleId, params);
  return toolResult({ success: true, ...result, event: "miniapp_open_ready" });
}

async function uiModuleToggleTool(agentContext, params = {}) {
  const moduleId = String(params.module_id || params.module_key || "").trim();
  if (!moduleId) return errorResult("module_id 或 module_key 为必填项");
  if (typeof params.enabled !== "boolean") return errorResult("enabled 必须为布尔值");
  const module = await setModuleStatus(makeCtx(agentContext), moduleId, { enabled: params.enabled });
  return toolResult({ success: true, event: "module_status_changed", module_id: module.id, module_key: module.module_key, status: module.status, module });
}

async function uiModuleRollbackTool(agentContext, params = {}) {
  const moduleId = String(params.module_id || params.module_key || "").trim();
  const versionId = String(params.version_id || "").trim();
  if (!moduleId || !versionId) return errorResult("module_id/module_key 和 version_id 都是必填项");
  const module = await activateVersion(makeCtx(agentContext), moduleId, versionId, {
    expected_current_version_id: params.expected_current_version_id,
    reason: params.reason,
  });
  return toolResult({ success: true, event: "module_version_changed", module_id: module.id, module_key: module.module_key, module });
}

const PRODUCT_TOOL_HANDLERS = {
  capability_search: async (_agentContext, params = {}) => {
    const catalog = await capabilityCatalog();
    const capabilities = searchCapabilities(catalog, params);
    return toolResult({ success: true, count: capabilities.length, capabilities });
  },
  capability_describe: async (_agentContext, params = {}) => {
    const operationId = String(params.operation_id || "").trim();
    if (!operationId) return errorResult("operation_id 为必填项");
    const detail = describeCapability(await capabilityCatalog(), operationId);
    return detail ? toolResult({ success: true, capability: detail }) : errorResult(`未找到能力: ${operationId}`);
  },
  capability_invoke: async (agentContext, params = {}) => {
    const operationId = String(params.operation_id || "").trim();
    if (!operationId) return errorResult("operation_id 为必填项");
    const item = findCapability(await capabilityCatalog(), operationId);
    if (!item) return errorResult(`未找到能力: ${operationId}`);
    const ctx = makeCtx(agentContext);
    const scoped = resolveCapabilityProjectScope(item, params.params || {}, agentContext?.project_id);
    if (scoped.error) return errorResult(scoped.error, { code: "project_scope_violation" });
    const routeParams = scoped.params;
    if (scoped.needsMembershipCheck) {
      const member = await ctx.queryOne(
        `SELECT 1 AS allowed FROM project_members
          WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1`,
        [scoped.projectId, ctx.userId],
      ).catch(() => null);
      if (!member) return errorResult("项目不存在或无权限", { code: "project_access_denied" });
    }
    const missing = item.path_params.filter((name) => routeParams[name] == null || routeParams[name] === "");
    if (missing.length) return errorResult(`缺少路径参数: ${missing.join(", ")}`);
    const routeBody = params.body && typeof params.body === "object" ? { ...params.body } : {};
    if (!routeBody.session_id && item.safety !== 'read') {
      routeBody.session_id = agentContext?.session_id || agentContext?.input_data?.session_id || null;
    }
    const routeQuery = params.query && typeof params.query === "object" ? params.query : {};
    const validation = validateCapabilityInput(item, { params: routeParams, query: routeQuery, body: routeBody });
    if (!validation.valid) {
      return errorResult("能力参数不正确", {
        code: "invalid_capability_input",
        operation_id: operationId,
        schema_quality: validation.schemaQuality,
        corrections: validation.errors,
      });
    }
    const idempotencyKey = String(params.idempotency_key || "").trim();
    let idempotencyClaim = null;
    if (item.safety !== "read" && idempotencyKey) {
      idempotencyClaim = claimCapabilityInvocation({
        userId: ctx.userId,
        projectId: scoped.projectId || agentContext?.project_id || null,
        operationId,
        idempotencyKey,
        input: { params: routeParams, query: routeQuery, body: routeBody },
      });
      if (idempotencyClaim.state === "conflict") {
        return errorResult("同一 idempotency_key 不能用于不同参数", { code: "idempotency_conflict" });
      }
      if (idempotencyClaim.state === "in_progress") {
        return errorResult("相同操作正在处理中", { code: "idempotency_in_progress", retryable: true });
      }
      if (idempotencyClaim.state === "replay") {
        return toolResult({
          success: true,
          operation_id: operationId,
          safety: item.safety,
          long_running: item.long_running,
          idempotent_replay: true,
          result: boundedCapabilityResult(idempotencyClaim.result),
        });
      }
    }
    let result;
    try {
      result = await item.route.fn(ctx, {
        params: routeParams,
        query: routeQuery,
        body: routeBody,
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
      });
      if (idempotencyClaim?.id) completeCapabilityInvocation(idempotencyClaim.id, result);
    } catch (error) {
      if (idempotencyClaim?.id) failCapabilityInvocation(idempotencyClaim.id, error);
      throw error;
    }
    return toolResult({
      success: true,
      operation_id: operationId,
      safety: item.safety,
      long_running: item.long_running,
      result: boundedCapabilityResult(result),
    });
  },
  project_list: projectListTool,
  project_detail: projectDetailTool,
  create_smart_qa_project: projectCreateTool,
  project_create: projectCreateTool,
  project_session_move: projectSessionMoveTool,
  file_classify: fileClassifyTool,
  structured_import: structuredImportTool,
  database_file_import: databaseFileImportTool,
  unstructured_import: unstructuredImportTool,
  job_status: jobStatusTool,
  query_smoke_test: querySmokeTestTool,
  skill_list: skillListTool,
  skill_registry_search: skillRegistrySearchTool,
  skill_download: skillDownloadTool,
  skill_create: skillCreateTool,
  skill_update: skillUpdateTool,
  skill_toggle: skillToggleTool,
  skill_delete: skillDeleteTool,
  project_skill_list: projectSkillListTool,
  project_skill_enable: (agentContext, params) => projectSkillSetTool(agentContext, params, true),
  project_skill_disable: (agentContext, params) => projectSkillSetTool(agentContext, params, false),
  mcp_provider_list: mcpProviderListTool,
  mcp_provider_create: mcpProviderCreateTool,
  mcp_provider_update: mcpProviderUpdateTool,
  mcp_provider_toggle: mcpProviderToggleTool,
  mcp_provider_delete: mcpProviderDeleteTool,
  mcp_provider_test: mcpProviderTestTool,
  mcp_provider_rediscover: mcpProviderRediscoverTool,
  project_mcp_provider_list: projectMcpProviderListTool,
  project_mcp_provider_enable: (agentContext, params) => projectMcpProviderSetTool(agentContext, params, true),
  project_mcp_provider_disable: (agentContext, params) => projectMcpProviderSetTool(agentContext, params, false),
  project_mcp_provider_reset: projectMcpProviderResetTool,
  ui_module_list: uiModuleListTool,
  ui_module_get: uiModuleGetTool,
  ui_skill_product_draft_create: uiSkillProductDraftCreateTool,
  ui_module_draft_create: uiModuleDraftCreateTool,
  ui_module_draft_validate: uiModuleDraftValidateTool,
  ui_module_draft_preview: uiModuleDraftPreviewTool,
  ui_module_draft_install: uiModuleDraftInstallTool,
  miniapp_agent_export_draft: miniAppAgentExportDraftTool,
  miniapp_agent_export_validate: miniAppAgentExportValidateTool,
  miniapp_agent_export_publish: miniAppAgentExportPublishTool,
  miniapp_agent_export_suspend: miniAppAgentExportSuspendTool,
  miniapp_list: miniAppListTool,
  miniapp_use: miniAppUseTool,
  miniapp_open: miniAppOpenTool,
  ui_module_toggle: uiModuleToggleTool,
  ui_module_rollback: uiModuleRollbackTool,
};

const PARAMS = {
  capability_search: Type.Object({
    query: Type.String({ description: "要查找的 App 能力,使用简短自然语言" }),
    domain: Type.Optional(Type.String({ description: "可选能力域" })),
    safety: Type.Optional(Type.String({ description: "可选 read | write | delete | execute" })),
    limit: Type.Optional(Type.Number({ description: "返回数量,默认 8,最大 20" })),
  }),
  capability_describe: Type.Object({
    operation_id: Type.String({ description: "capability_search 返回的 operation_id" }),
  }),
  capability_invoke: Type.Object({
    operation_id: Type.String({ description: "capability_search 返回的 operation_id" }),
    params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "路径参数" })),
    query: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "查询参数" })),
    body: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "请求体" })),
    idempotency_key: Type.Optional(Type.String({ description: "长任务或可重试写入的幂等键" })),
  }),
  project_list: Type.Object({
    search: Type.Optional(Type.String({ description: "按项目名称搜索(可选)" })),
  }),
  project_detail: Type.Object({
    project_id: Type.Optional(Type.String({ description: "项目 ID;省略且在项目会话中时默认当前项目" })),
    id: Type.Optional(Type.String({ description: "项目 ID,兼容字段" })),
    name: Type.Optional(Type.String({ description: "按项目名称唯一匹配" })),
    project_name: Type.Optional(Type.String({ description: "项目名称,兼容字段" })),
  }),
  project_create: Type.Object({
    name: Type.String({ description: "项目名称" }),
    description: Type.Optional(Type.String({ description: "项目描述" })),
  }),
  create_smart_qa_project: Type.Object({
    name: Type.String({ description: "智能问数项目名称" }),
    description: Type.Optional(Type.String({ description: "项目描述" })),
  }),
  project_session_move: Type.Object({
    target_project_id: Type.String({ description: "目标问数项目 ID" }),
    session_id: Type.Optional(Type.String({ description: "要迁移的会话 ID;默认当前会话" })),
    from_project_id: Type.Optional(Type.String({ description: "源工作区 ID;默认当前工作区" })),
  }),
  file_classify: Type.Object({
    paths: Type.Array(Type.String(), { description: "本地文件或目录路径列表" }),
    recursive: Type.Optional(Type.Boolean({ description: "目录是否递归扫描,默认 true" })),
  }),
  structured_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_paths: Type.Array(Type.String(), { description: "CSV/Excel/JSON/Parquet 文件路径" }),
    data_source_name: Type.Optional(Type.String({ description: "结构化数据源名称" })),
    description: Type.Optional(Type.String({ description: "数据源描述" })),
  }),
  database_file_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_path: Type.String({ description: "SQLite/DuckDB 本地文件路径" }),
    name: Type.Optional(Type.String({ description: "数据库连接名称" })),
    db_type: Type.Optional(Type.String({ description: "SQLite 或 DuckDB;省略时按扩展名识别" })),
    description: Type.Optional(Type.String({ description: "连接描述" })),
    enrich: Type.Optional(Type.Boolean({ description: "是否同步示例值并刷新 Schema 文件;默认 false" })),
  }),
  unstructured_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_paths: Type.Array(Type.String(), { description: "Markdown/PDF/DOCX/TXT 等文档路径" }),
    data_source_name: Type.Optional(Type.String({ description: "非结构化数据源名称" })),
    description: Type.Optional(Type.String({ description: "数据源描述" })),
  }),
  job_status: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    kind: Type.Optional(Type.String({ description: "database | structured | unstructured | project" })),
    connection_id: Type.Optional(Type.String({ description: "数据库连接 ID" })),
    data_source_id: Type.Optional(Type.String({ description: "结构化或非结构化数据源 ID" })),
    structured_data_source_id: Type.Optional(Type.String({ description: "结构化数据源 ID" })),
    unstructured_data_source_id: Type.Optional(Type.String({ description: "非结构化数据源 ID" })),
    job_id: Type.Optional(Type.String({ description: "提交后台任务时返回的 job.id;优先按任务 ID 精确查询" })),
  }),
  query_smoke_test: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    connection_id: Type.String({ description: "数据库连接 ID" }),
  }),
  skill_list: Type.Object({}),
  skill_registry_search: Type.Object({
    query: Type.String({ description: "要查找的 Skill 名称，或完整 GitHub SKILL.md 地址" }),
    limit: Type.Optional(Type.Number({ description: "最多返回数量，默认 8" })),
  }),
  skill_download: Type.Object({
    source_url: Type.String({ description: "skill_registry_search 返回的 source_url，或公开 GitHub SKILL.md 地址" }),
    name: Type.Optional(Type.String({ description: "导入到 App 的 Skill 名称；默认沿用 SKILL.md 中的 name" })),
    description: Type.Optional(Type.String({ description: "可选说明；默认沿用 SKILL.md" })),
    category: Type.Optional(Type.String({ description: "可选分类" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "可选标签" })),
    enable_product_storage: Type.Optional(Type.Boolean({ description: "做成需要持续保存数据的小程序时设为 true；会加入受控产品数据读写工具" })),
    replace_existing: Type.Optional(Type.Boolean({ description: "同名 Skill 已存在时是否用新下载版本更新；默认 false" })),
  }),
  skill_create: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.String({ description: "Skill 描述" }),
    instructions: Type.String({ description: "Skill 指令 Markdown" }),
    category: Type.Optional(Type.String({ description: "分类" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
    allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "允许调用的工具名" })),
    runtime: Type.Optional(Type.String({ description: "运行类型: prompt | service | workflow;默认 prompt" })),
    side_effect: Type.Optional(Type.String({ description: "副作用等级: read | write | execute;默认 read" })),
    requires_project: Type.Optional(Type.Boolean({ description: "是否必须在问数项目上下文中使用;默认 false" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;默认 true" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;默认 true" })),
  }),
  skill_update: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.Optional(Type.String({ description: "Skill 描述" })),
    instructions: Type.Optional(Type.String({ description: "Skill 指令 Markdown" })),
    category: Type.Optional(Type.String({ description: "分类" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
    allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "允许调用的工具名" })),
    runtime: Type.Optional(Type.String({ description: "运行类型: prompt | service | workflow" })),
    side_effect: Type.Optional(Type.String({ description: "副作用等级: read | write | execute" })),
    requires_project: Type.Optional(Type.Boolean({ description: "是否必须在问数项目上下文中使用" })),
  }),
  skill_toggle: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;false 时所有项目都不能执行" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_enabled: Type.Optional(Type.Boolean({ description: "兼容字段,等同 default_enabled" })),
  }),
  skill_delete: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
  }),
  project_skill_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
  }),
  project_skill_enable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App Skill 名称" }),
  }),
  project_skill_disable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App Skill 名称" }),
  }),
  mcp_provider_list: Type.Object({}),
  mcp_provider_create: Type.Object({
    provider_name: Type.String({ description: "MCP Provider 名称,只能包含小写字母、数字、下划线和中划线" }),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    command: Type.String({ description: "启动 MCP server 的命令,例如 node、python、npx" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象,key/value 都会按字符串写入" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖;默认 true" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;默认 true" })),
  }),
  mcp_provider_update: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
    command: Type.Optional(Type.String({ description: "启动 MCP server 的命令" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象" })),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关" })),
  }),
  mcp_provider_toggle: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;false 时所有项目都不能执行" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_enabled: Type.Optional(Type.Boolean({ description: "兼容字段,等同 default_enabled" })),
  }),
  mcp_provider_delete: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
  }),
  mcp_provider_test: Type.Object({
    provider_name: Type.Optional(Type.String({ description: "临时测试名称;可省略" })),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    command: Type.String({ description: "启动 MCP server 的命令" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象" })),
  }),
  mcp_provider_rediscover: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
  }),
  project_mcp_provider_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
  }),
  project_mcp_provider_enable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
  project_mcp_provider_disable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
  project_mcp_provider_reset: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
  ui_module_list: Type.Object({
    status: Type.Optional(Type.String({ description: "可选: active | disabled | error | incompatible" })),
  }),
  ui_module_get: Type.Object({
    module_id: Type.Optional(Type.String({ description: "模块 ID" })),
    module_key: Type.Optional(Type.String({ description: "模块稳定名称" })),
  }),
  ui_skill_product_draft_create: Type.Object({
    skill_name: Type.String({ description: "要固化的 Skill 名称" }),
    project_id: Type.Optional(Type.String({ description: "Skill 绑定的项目 ID；项目 Skill 必填" })),
    module_key: Type.String({ description: "产品稳定名称，例如 stock-research" }),
    name: Type.String({ description: "侧边栏产品名称" }),
    description: Type.Optional(Type.String({ description: "产品定位和主要用途" })),
    icon: Type.Optional(Type.String({ description: "图标名" })),
    base_module_id: Type.Optional(Type.String({ description: "升级已有 Skill Product 时传模块 ID" })),
    version: Type.Optional(Type.String({ description: "语义版本，首次默认 1.0.0" })),
    request_text: Type.Optional(Type.String({ description: "用户原始产品要求" })),
    sidebar: Type.Optional(Type.Any({ description: "侧边栏设置 visible/group/order" })),
    allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "固化后允许的工具；不能超出 Skill 声明，写入和执行仍逐次确认" })),
    blueprint: Type.Optional(Type.Any({ description: "Product Blueprint：product/jobs、domain、commands、surfaces、stateSchema、acceptanceTests。页面命令使用 agent.intent，由确定性编译器生成动作和 MiniApp Package。" })),
    navigation: Type.Optional(Type.Any({ description: "产品内页面导航，例如 [{page:'dashboard',label:'看板'}]" })),
    pages: Type.Optional(Type.Any({ description: "完整产品页面字典；必须或将自动包含 AgentWorkspace" })),
    actions: Type.Optional(Type.Any({ description: "页面使用的受控 state/provider 动作" })),
    permissions: Type.Optional(Type.Array(Type.String(), { description: "除 Skill 运行外需要的最小模块权限" })),
    idempotency_key: Type.Optional(Type.String({ description: "防止重复生成草稿的键" })),
  }),
  ui_module_draft_create: Type.Object({
    module_key: Type.String({ description: "稳定模块名,例如 stock-market" }),
    name: Type.String({ description: "侧边栏显示名称" }),
    description: Type.Optional(Type.String({ description: "模块说明" })),
    icon: Type.Optional(Type.String({ description: "图标名" })),
    base_module_id: Type.Optional(Type.String({ description: "修改已有模块时传模块 ID" })),
    version: Type.Optional(Type.String({ description: "语义版本,首次默认 1.0.0" })),
    request_text: Type.Optional(Type.String({ description: "用户的原始要求" })),
    requirements: Type.Optional(Type.Any({ description: "统一 Requirement Bundle：goal、sources、constraints、acceptanceCriteria。Skill 只能作为 sources 中的需求模板，不会获得运行权限" })),
    requirement_sources: Type.Optional(Type.Array(Type.Any(), { description: "需求来源简写：conversation、skill、document、existing_miniapp、reference 等；会并入 Requirement Bundle" })),
    blueprint: Type.Optional(Type.Any({ description: "通用 Product Blueprint。普通小程序请把可执行逻辑放在 actions，不要声明 agent.intent commands；需要主 Agent 调用时安装后另行发布能力" })),
    compile_miniapp: Type.Optional(Type.Boolean({ description: "是否生成 MiniApp Package；提供 requirements 或 blueprint 时会自动生成" })),
    sidebar: Type.Optional(Type.Any({ description: "侧边栏设置: visible/group/order" })),
    permissions: Type.Optional(Type.Array(Type.String(), { description: "模块申请的最小权限" })),
    pages: Type.Optional(Type.Any({ description: "页面字典,节点使用受支持的 JSON 组件" })),
    page: Type.Optional(Type.Any({ description: "只有一个页面时可直接提供页面" })),
    actions: Type.Optional(Type.Any({ description: "state.get/state.set/provider.call 动作字典" })),
    content: Type.Optional(Type.Any({ description: "完整 manifest/pages/actions 定义" })),
    idempotency_key: Type.Optional(Type.String({ description: "防止重复创建草稿的键" })),
  }),
  ui_module_draft_validate: Type.Object({
    draft_id: Type.String({ description: "草稿 ID" }),
    expected_revision: Type.Optional(Type.Number({ description: "期望草稿修订号" })),
  }),
  ui_module_draft_preview: Type.Object({
    draft_id: Type.String({ description: "草稿 ID" }),
    expected_revision: Type.Optional(Type.Number({ description: "期望草稿修订号" })),
    validation_hash: Type.Optional(Type.String({ description: "上次检查返回的哈希" })),
  }),
  ui_module_draft_install: Type.Object({
    draft_id: Type.String({ description: "草稿 ID" }),
    expected_revision: Type.Number({ description: "预览时返回的草稿修订号" }),
    validation_hash: Type.String({ description: "预览时返回的检查哈希" }),
    preview_token: Type.String({ description: "预览时返回的一次性确认令牌" }),
    grant_permissions: Type.Optional(Type.Boolean({ description: "是否同意草稿申请的全部权限" })),
    permission_decisions: Type.Optional(Type.Any({ description: "按权限名给出 true/false" })),
    idempotency_key: Type.Optional(Type.String({ description: "防止重复安装的键" })),
  }),
  miniapp_agent_export_draft: Type.Object({
    module_id: Type.Optional(Type.String({ description: "小程序 ID" })),
    module_key: Type.Optional(Type.String({ description: "小程序稳定名称" })),
    skill_name: Type.String({ description: "发布给主 Agent 的能力名称" }),
    description: Type.Optional(Type.String({ description: "这组能力的用途和边界" })),
    export_version: Type.Optional(Type.String({ description: "导出 Skill 版本，默认 1.0.0" })),
    commands: Type.Array(Type.Any(), { description: "要公开的动作列表。每项包含 action，可选 name/title/description/input_schema/output_schema/open_page" }),
    idempotency_key: Type.Optional(Type.String({ description: "防止重复生成导出草稿的键" })),
  }),
  miniapp_agent_export_validate: Type.Object({
    export_id: Type.String({ description: "Agent 能力导出草稿 ID" }),
  }),
  miniapp_agent_export_publish: Type.Object({
    export_id: Type.String({ description: "Agent 能力导出草稿 ID" }),
    validation_hash: Type.String({ description: "检查返回的 validation_hash" }),
  }),
  miniapp_agent_export_suspend: Type.Object({
    export_id: Type.String({ description: "要停用的 Agent 能力 ID" }),
  }),
  miniapp_list: Type.Object({
    status: Type.Optional(Type.String({ description: "默认 published；可选 draft | ready | published | needs_review | suspended" })),
  }),
  miniapp_use: Type.Object({
    export_id: Type.Optional(Type.String({ description: "已发布的 Agent 能力 ID" })),
    skill_name: Type.Optional(Type.String({ description: "已发布的 Agent 能力名称" })),
    command: Type.String({ description: "要执行的公开命令名" }),
    input: Type.Optional(Type.Any({ description: "符合命令 inputSchema 的结构化输入" })),
    request_id: Type.Optional(Type.String({ description: "幂等请求 ID" })),
  }),
  miniapp_open: Type.Object({
    module_id: Type.Optional(Type.String({ description: "小程序 ID" })),
    module_key: Type.Optional(Type.String({ description: "小程序稳定名称" })),
    page_id: Type.Optional(Type.String({ description: "要打开的页面；默认入口页" })),
    invocation_id: Type.Optional(Type.String({ description: "从 miniapp_use 结果接力时传 invocation_id" })),
  }),
  ui_module_toggle: Type.Object({
    module_id: Type.Optional(Type.String({ description: "模块 ID" })),
    module_key: Type.Optional(Type.String({ description: "模块稳定名称" })),
    enabled: Type.Boolean({ description: "true 启用,false 停用" }),
  }),
  ui_module_rollback: Type.Object({
    module_id: Type.Optional(Type.String({ description: "模块 ID" })),
    module_key: Type.Optional(Type.String({ description: "模块稳定名称" })),
    version_id: Type.String({ description: "要切换到的已安装版本 ID" }),
    expected_current_version_id: Type.Optional(Type.String({ description: "当前版本 ID,用于防止并发覆盖" })),
    reason: Type.Optional(Type.String({ description: "切换原因" })),
  }),
};

export function createProductTools(agentContext) {
  const hasDb = !!agentContext?.db?.query && !!agentContext?.db?.queryOne;
  if (!hasDb) return [];
  return PRODUCT_TOOL_CATALOG.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: PARAMS[def.name] || Type.Object({}),
    execute: async (_toolCallId, params) => {
      const handler = PRODUCT_TOOL_HANDLERS[def.name];
      if (!handler) return errorResult(`工具未实现: ${def.name}`);
      try {
        return await handler(agentContext, params || {});
      } catch (e) {
        return errorResult(e?.message || String(e), { tool: def.name });
      }
    },
  }));
}
