import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { query, queryOne } from '../../db.js';
import { BaseTool, Result } from '../core/base_tool.js';
import { latestResourceJob } from '../jobs/background_jobs.js';
import { assertReadOnlySql } from '../tools/readonly_sql.js';
import { inspectSchemaSnapshot } from '../semantic/schema_file_service.js';
import { markdownPathForDocument } from '../datasources/unstructured/document_processing_service.js';

const MAX_SQL_ATTEMPTS = 8;

function projectRoot(projectId) {
  const projectsDir = process.env.YIW_PROJECTS_DIR || join(homedir(), '.yiw', 'projects');
  return join(projectsDir, String(projectId));
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ').trim();
}

function relativePath(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel : '';
}

export function schemaContentStatus(snapshotStatus) {
  if (snapshotStatus === 'missing') return 'missing';
  if (snapshotStatus === 'stale') return 'stale';
  return 'ready';
}

export function metadataEnrichmentStatus(job) {
  const status = String(job?.status || '').trim();
  if (!status) return 'not_scheduled';
  if (status === 'completed') return 'ready';
  if (status === 'failed' || status === 'failed_permanent' || status === 'blocked_configuration') return 'failed';
  if (['queued', 'running', 'retry_wait', 'partial'].includes(status)) return 'preparing';
  return status;
}

export async function inspectQueryWorkspace({ projectId, bds, session, workspaceRoot = null }) {
  if (!projectId) throw new Error('缺少 projectId，无法读取 QueryAgent 工作区');
  const root = workspaceRoot || projectRoot(projectId);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error(`项目工作区不存在: ${root}`);
  const sources = [];
  const documents = [];

  for (const source of bds?.get_database_sources?.() || []) {
    let schemaPath = '';
    let snapshotStatus = 'missing';
    let generatedAt = '';
    const notes = [];
    try {
      const snapshot = await inspectSchemaSnapshot(
        { query, queryOne },
        { projectId, connectionId: source.connection_id },
      );
      snapshotStatus = snapshot.status;
      generatedAt = snapshot.generatedAt || '';
      if (snapshot.sql) schemaPath = relativePath(root, snapshot.path);
      if (snapshot.status === 'missing') notes.push('Schema 产物缺失；请在数据源设置中同步或重新准备');
      if (snapshot.status === 'stale') notes.push('Schema 产物已过期；本次仍读取上一版，不在问答中重建');
    } catch (error) {
      notes.push(error?.message || String(error));
    }
    const job = latestResourceJob('database_connection', source.connection_id);
    if (job?.error_message) notes.push(job.error_message);
    sources.push({
      source_id: String(source.id),
      name: source.datasource_name || source.id,
      type: 'database',
      dialect: source.db_type || 'sql',
      path: schemaPath,
      raw_status: 'queryable',
      content_status: schemaContentStatus(snapshotStatus),
      enrichment_status: metadataEnrichmentStatus(job),
      generated_at: generatedAt,
      note: notes.join('；'),
    });
  }

  for (const source of bds?.get_unstructured_sources?.() || []) {
    const sourcePath = join(root, 'documents', String(source.raw_id));
    const rows = typeof source._allDocuments === 'function'
      ? await source._allDocuments().catch(() => [])
      : await source._documents().catch(() => []);
    let readyCount = 0;
    let failedCount = 0;
    let preparingCount = 0;
    for (const doc of rows) {
      const expected = markdownPathForDocument(projectId, source.raw_id, doc.id);
      const stored = doc.markdown_path ? resolve(String(doc.markdown_path)) : expected;
      const selected = await stat(expected).then((info) => info.isFile() ? expected : null).catch(() => null)
        || await stat(stored).then((info) => info.isFile() ? stored : null).catch(() => null);
      const status = String(doc.status || 'completed').toLowerCase();
      const path = selected ? relativePath(root, selected) : '';
      const ready = status === 'completed' && Boolean(path);
      if (ready) readyCount += 1;
      else if (status === 'failed') failedCount += 1;
      else preparingCount += 1;
      documents.push({
        source_id: String(source.id),
        source_name: source.datasource_name || source.id,
        document_id: String(doc.id),
        title: doc.title || doc.id,
        description: doc.description || '',
        file_ext: String(doc.file_ext || '').replace(/^\./, '').toLowerCase(),
        content_format: doc.content_format || '',
        status: ready ? 'ready' : status === 'completed' ? 'missing' : status,
        progress: Number(doc.progress || 0),
        path,
        error: doc.error_msg || (status === 'completed' && !path ? 'Markdown 文件缺失' : ''),
      });
    }
    const contentStatus = failedCount > 0
      ? 'failed'
      : preparingCount > 0
        ? 'preparing'
        : rows.length > 0 && readyCount === rows.length
          ? 'ready'
          : 'empty';
    sources.push({
      source_id: String(source.id),
      name: source.datasource_name || source.id,
      type: 'documents',
      dialect: '-',
      path: relativePath(root, sourcePath),
      raw_status: rows.length ? 'registered' : 'empty',
      content_status: contentStatus,
      enrichment_status: '-',
      generated_at: '',
      note: `${readyCount}/${rows.length} 个文档可读取${failedCount ? `，${failedCount} 个失败` : ''}${preparingCount ? `，${preparingCount} 个处理中` : ''}`,
    });
  }

  if (session?.intermediate_ds) {
    sources.push({
      source_id: 'session_intermediate',
      name: session.intermediateName,
      type: 'database',
      dialect: 'duckdb',
      path: '',
      raw_status: 'queryable',
      content_status: 'session',
      enrichment_status: '-',
      generated_at: '',
      note: '会话中间库；表结构见运行上下文的中间结果。',
    });
  }

  const sourceLines = [
    '# QueryAgent Sources',
    '',
    '| source_id | name | type | dialect | path | raw_status | content_status | enrichment_status | generated_at | note |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...sources.map((source) => `| ${markdownCell(source.source_id)} | ${markdownCell(source.name)} | ${source.type} | ${markdownCell(source.dialect)} | ${markdownCell(source.path)} | ${markdownCell(source.raw_status)} | ${markdownCell(source.content_status)} | ${markdownCell(source.enrichment_status)} | ${markdownCell(source.generated_at)} | ${markdownCell(source.note)} |`),
    '',
    '执行 SQL 时必须把这里的 source_id 原样传给 execute_sql。raw_status=queryable 且 content_status=ready/stale 时即可查询；enrichment_status 只表示描述、样例等离线增强进度，不影响原始数据可查询。Schema 和 Markdown 是离线准备的事实产物，在线问答不会自动重建或刷新；代码、脚本和输出文件可以在审批后写入项目工作区。',
  ];
  const documentLines = [
    '# QueryAgent Documents',
    '',
    '| source_id | source_name | document_id | title | description | file_ext | content_format | status | progress | path | error |',
    '|---|---|---|---|---|---|---|---|---:|---|---|',
    ...documents.map((doc) => `| ${markdownCell(doc.source_id)} | ${markdownCell(doc.source_name)} | ${markdownCell(doc.document_id)} | ${markdownCell(doc.title)} | ${markdownCell(doc.description)} | ${markdownCell(doc.file_ext)} | ${markdownCell(doc.content_format)} | ${markdownCell(doc.status)} | ${markdownCell(doc.progress)} | ${markdownCell(doc.path)} | ${markdownCell(doc.error)} |`),
  ];
  return {
    root,
    sources,
    documents,
    sourceCatalog: sourceLines.join('\n'),
    documentCatalog: documentLines.join('\n'),
  };
}

export class DirectSqlTool extends BaseTool {
  constructor({ bds, session } = {}) {
    super('execute_sql', '在指定数据源执行一条只读 SQL，并把结果写入会话中间库。');
    this.bds = bds;
    this.session = session;
    this.attempted = new Set();
  }

  resolveSource(sourceId) {
    const requested = String(sourceId || '').trim();
    if (requested === 'session_intermediate') return this.session?.intermediate_ds || null;
    if (requested) return this.bds?.get_data_source?.(requested) || null;
    const databases = this.bds?.get_database_sources?.() || [];
    return databases.length === 1 ? databases[0] : null;
  }

  async execute(context, kwargs = {}) {
    const source = this.resolveSource(kwargs.source_id);
    if (!source || !['database_connection', 'intermediate_data_source'].includes(source.source_type)) {
      return Result.createError('source_id 无效或不是可查询数据库；请核对本轮数据源清单');
    }
    let sql;
    try {
      sql = assertReadOnlySql(kwargs.sql);
    } catch (error) {
      return Result.createError(error?.message || String(error));
    }
    const key = `${source.id}:${sql.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (this.attempted.has(key)) return Result.createError('这条 SQL 已执行过，请根据结果修改 SQL，不要原样重试');
    if (this.attempted.size >= MAX_SQL_ATTEMPTS) return Result.createError(`SQL 尝试次数已达到上限(${MAX_SQL_ATTEMPTS})`);
    this.attempted.add(key);

    const result = await source.query(sql, {
      project_id: context.project_id,
      session_id: context.session_id,
      business_data_sources: this.bds,
    });
    if (!result?.success) return Result.createError(result?.message || 'SQL 查询失败');
    const question = String(kwargs.question || context.input_data?.user_message || 'SQL 查询').trim();
    return Result.create({
      operator: {
        nodetag: 'DirectSqlQuery',
        source_id: source === this.session?.intermediate_ds ? 'session_intermediate' : source.id,
        source_name: source.datasource_name || source.id,
        sql,
        query: question,
      },
      result: { rows: result.data || [], columns: result.columns || [] },
      'sub-query': question,
    }, 'SQL 查询完成');
  }
}
