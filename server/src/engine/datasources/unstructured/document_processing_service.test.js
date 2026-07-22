import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('text document completes after Markdown is stored, without an embedding model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-processing-'));
  process.env.DB_SQLITE_PATH = join(dir, 'local.db');
  process.env.YIW_PROJECTS_DIR = join(dir, 'projects');
  try {
    const sourcePath = join(dir, 'guide.txt');
    await writeFile(sourcePath, 'YiW 文档处理\n\n这是无需向量模型的内容。', 'utf8');
    const { sqlite } = await import('../../../db.js');
    const { DocumentProcessingService } = await import('./document_processing_service.js');
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO unstructured_documents
       (id, project_id, unstructured_data_source_id, title, source, file_path, file_ext, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', ?, 'txt', 'pending', 0, ?, ?)`,
    ).run('doc-1', 'project-1', 'source-1', 'guide.txt', sourcePath, now, now);

    const result = await DocumentProcessingService.processDocument('doc-1', { projectId: 'project-1' });
    const row = sqlite.prepare('SELECT status, markdown_path, chunk_count FROM unstructured_documents WHERE id=?').get('doc-1');
    const chunks = sqlite.prepare('SELECT embedding, embedding_content FROM unstructured_contents WHERE document_id=?').all('doc-1');

    assert.equal(result.success, true);
    assert.equal(row.status, 'completed');
    assert.ok(row.markdown_path.endsWith('/documents/source-1/doc-1.md'));
    assert.match(await readFile(row.markdown_path, 'utf8'), /无需向量模型/);
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => chunk.embedding === null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
