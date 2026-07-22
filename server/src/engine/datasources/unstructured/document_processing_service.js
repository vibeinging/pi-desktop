// 迁移自 yiw_kernel/semantic_catalogs/unstructured_data/document_processing_service.py(桌面精简版)
//
// 文档处理流水线:load(转 Markdown) → 保存 .md → split(分块) → store(存 unstructured_contents)
// → 更新 unstructured_documents.status/chunk_count。失败置 status='failed' + error_msg,不抛。

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { sqlite, query, queryOne } from '../../../db.js';
import { loadDocument } from './document_loaders.js';
import { splitText } from './text_splitter.js';
import { latestResourceJob, updateBackgroundJob } from '../../jobs/background_jobs.js';

function setStatus(id, status, progress, errorMsg = null) {
  try {
    sqlite.prepare(
      `UPDATE unstructured_documents SET status=?, progress=?, error_msg=?, updated_at=? WHERE id=?`,
    ).run(status, progress, errorMsg, new Date().toISOString(), id);
  } catch { /* 状态更新失败不致命 */ }
}

export function markdownPathForDocument(projectId, dataSourceId, documentId) {
  const projectsDir = process.env.YIW_PROJECTS_DIR || join(homedir(), '.yiw', 'projects');
  return join(projectsDir, String(projectId), 'documents', String(dataSourceId), `${documentId}.md`);
}

export class DocumentProcessingService {
  /**
   * 处理单个文档(整条 ingest 流水线)。
   * @param {string} documentId unstructured_documents.id
   * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
   * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
   */
  static async processDocument(documentId, { chunkSize = 512, chunkOverlap = 50, projectId = null, jobId = null } = {}) {
    const doc = await queryOne(
      `SELECT id, file_path, file_ext, title, project_id, unstructured_data_source_id FROM unstructured_documents
        WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    ).catch(() => null);
    if (!doc) {
      if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'document_not_found', error_message: '文档不存在', finished_at: new Date().toISOString() });
      return { success: false, message: '文档不存在' };
    }

    try {
      if (jobId) updateBackgroundJob(jobId, { status: 'running', progress: 5, started_at: new Date().toISOString(), incrementAttempt: true });
      setStatus(documentId, 'processing', 10);
      // 1) 转成 Markdown。图片使用项目副模型，普通文件不调用模型。
      const markdown = await loadDocument(doc.file_path, doc.file_ext, {
        projectId: projectId || doc.project_id,
      });
      if (!markdown || !String(markdown).trim()) {
        setStatus(documentId, 'failed', 0, '文档内容为空或无法提取');
        if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'empty_document', error_message: '文档内容为空或无法提取', finished_at: new Date().toISOString() });
        return { success: false, message: '文档内容为空或无法提取' };
      }
      // 2) Markdown 落到项目工作区，成为可查看、可迁移的正式文件。
      const markdownPath = markdownPathForDocument(doc.project_id, doc.unstructured_data_source_id, documentId);
      await mkdir(dirname(markdownPath), { recursive: true });
      await writeFile(markdownPath, String(markdown).trim() + '\n', 'utf8');
      sqlite.prepare(
        `UPDATE unstructured_documents SET markdown_path=?, content_format='markdown', progress=40, updated_at=? WHERE id=?`,
      ).run(markdownPath, new Date().toISOString(), documentId);

      // 3) 按 Markdown 段落分块
      const chunks = splitText(markdown, { chunkSize, chunkOverlap });
      if (!chunks.length) {
        setStatus(documentId, 'failed', 0, '文本分块为空');
        if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'empty_chunks', error_message: '文本分块为空', finished_at: new Date().toISOString() });
        return { success: false, message: '文本分块为空' };
      }
      setStatus(documentId, 'indexing', 70);
      // 4) 文本索引落库(先清旧 chunk 再插)，embedding 固定为空。
      sqlite.prepare(`DELETE FROM unstructured_contents WHERE document_id = ?`).run(documentId);
      const now = new Date().toISOString();
      const ins = sqlite.prepare(
        `INSERT INTO unstructured_contents
           (id, document_id, content_index, content_size, token_count, embedding_content, embedding, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      chunks.forEach((c, i) => {
        ins.run(randomUUID(), documentId, i, c.length, Math.ceil(c.length / 2), c, null, now, now);
      });
      sqlite.prepare(
        `UPDATE unstructured_documents SET status=?, chunk_count=?, progress=100, error_msg=?, updated_at=? WHERE id=?`,
      ).run('completed', chunks.length, null, now, documentId);

      if (jobId) updateBackgroundJob(jobId, {
        status: 'completed', progress: 100,
        result_json: { document_id: documentId, chunk_count: chunks.length, markdown_path: markdownPath },
        finished_at: now,
      });

      return {
        success: true,
        status: 'completed',
        chunk_count: chunks.length,
        markdown_path: markdownPath,
        message: `处理完成,已生成 Markdown 和 ${chunks.length} 个文本切片`,
      };
    } catch (e) {
      setStatus(documentId, 'failed', 0, String(e?.message ?? e));
      if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'document_processing_failed', error_message: String(e?.message ?? e), finished_at: new Date().toISOString() });
      return { success: false, message: String(e?.message ?? e) };
    }
  }
}

// 进程内串行后台队列:detach 文档处理,不阻塞 HTTP 响应。
// 串行(而非并发)避免多张图片同时调用副模型；桌面单用户串行足够。
// processDocument 自身全程 try/catch + 写 status,这里再兜一层 catch 保证队列不被单篇失败打断。
let _processChain = Promise.resolve();

/**
 * 把文档处理排进后台串行队列,立即返回该任务的 Promise(调用方一般 fire-and-forget)。
 * @param {string} documentId
 * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
 * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
 */
export function enqueueProcessDocument(documentId, opts = {}) {
  const run = () => DocumentProcessingService.processDocument(documentId, opts);
  const task = _processChain.then(run, run);
  _processChain = task.catch(() => {});
  return task;
}

/**
 * 启动续跑:扫描上次进程退出时卡在中途的文档，重新排进后台串行队列。
 * 文档处理是离线任务，App 重启后继续执行。
 */
export async function resumePendingDocuments() {
  try {
    const rows = await query(
      `SELECT id, project_id FROM unstructured_documents
        WHERE status IN ('pending','processing','indexing','embedding','embedding_failed','embedding_partial') AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [],
    ).catch(() => []);
    if (!rows.length) return 0;
    console.info(`[DocProcessing] 启动续跑:${rows.length} 个未完成文档重新入队`);
    for (const row of rows) {
      const job = latestResourceJob('unstructured_document', row.id);
      enqueueProcessDocument(row.id, { projectId: row.project_id, jobId: job?.id || null })
        .catch((e) => console.warn(`[DocProcessing] 续跑文档 ${row.id} 失败: ${e?.message ?? e}`));
    }
    return rows.length;
  } catch (e) {
    console.warn(`[DocProcessing] 启动续跑扫描失败: ${e?.message ?? e}`);
    return 0;
  }
}

export default DocumentProcessingService;
