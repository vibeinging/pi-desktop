import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentContext } from '../core/agent_context.js';
import {
  DirectSqlTool,
  inspectQueryWorkspace,
  metadataEnrichmentStatus,
  schemaContentStatus,
} from './query_workspace_tools.js';

test('structured data readiness is independent from optional metadata enrichment', () => {
  assert.equal(schemaContentStatus('ready'), 'ready');
  assert.equal(schemaContentStatus('stale'), 'stale');
  assert.equal(metadataEnrichmentStatus({ status: 'running' }), 'preparing');
  assert.equal(metadataEnrichmentStatus({ status: 'failed' }), 'failed');
  assert.equal(metadataEnrichmentStatus(null), 'not_scheduled');
});

test('execute_sql requires an authorized source_id and rejects writes and duplicate SQL', async () => {
  const calls = [];
  const source = {
    id: 'db_01',
    source_type: 'database_connection',
    datasource_name: '销售数据库',
    query: async (sql) => {
      calls.push(sql);
      return { success: true, data: [{ total: 2 }], columns: ['total'] };
    },
  };
  const bds = {
    get_data_source: (id) => id === 'db_01' ? source : null,
    get_database_sources: () => [source],
  };
  const tool = new DirectSqlTool({ bds, session: { intermediate_ds: null } });
  const context = new AgentContext({ project_id: 'project_1', session_id: 'session_1', input_data: {} });

  const success = await tool.execute(context, { source_id: 'db_01', sql: 'SELECT COUNT(*) AS total FROM orders', question: '订单数' });
  assert.equal(success.success, true);
  assert.equal(success.data.operator.source_id, 'db_01');
  assert.deepEqual(success.data.result.rows, [{ total: 2 }]);

  const duplicate = await tool.execute(context, { source_id: 'db_01', sql: 'SELECT COUNT(*) AS total FROM orders', question: '订单数' });
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error, /已执行过/);

  const write = await tool.execute(context, { source_id: 'db_01', sql: 'DELETE FROM orders', question: '删除订单' });
  assert.equal(write.success, false);
  assert.match(write.error, /只允许/);
  assert.equal(calls.length, 1);
});

test('query workspace maps authorized source ids to Markdown paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yiw-query-projects-'));
  try {
    const projectRoot = join(root, 'project_1');
    const markdownDir = join(projectRoot, 'documents', 'raw_docs_1');
    await mkdir(markdownDir, { recursive: true });
    await writeFile(join(markdownDir, 'doc_1.md'), '# 合同\n续约日期：2027-01-01\n', 'utf8');
    const source = {
      id: 'source_docs_1',
      raw_id: 'raw_docs_1',
      datasource_name: '合同资料',
      _allDocuments: async () => [
        {
          id: 'doc_1',
          title: '续约合同',
          description: '客户续约资料',
          status: 'completed',
          progress: 100,
          markdown_path: join(markdownDir, 'doc_1.md'),
        },
        {
          id: 'doc_2',
          title: '扫描附件',
          description: '等待 OCR',
          status: 'failed',
          progress: 0,
          error_msg: '未配置 OCR 模型',
          markdown_path: '',
        },
      ],
    };
    const workspace = await inspectQueryWorkspace({
      projectId: 'project_1',
      bds: {
        get_database_sources: () => [],
        get_unstructured_sources: () => [source],
      },
      session: { intermediate_ds: null },
      workspaceRoot: projectRoot,
    });
    assert.match(workspace.sourceCatalog, /source_docs_1.*合同资料.*documents\/raw_docs_1.*registered.*failed/);
    assert.match(workspace.documentCatalog, /source_docs_1.*doc_1.*续约合同.*ready.*100.*documents\/raw_docs_1\/doc_1\.md/);
    assert.match(workspace.documentCatalog, /source_docs_1.*doc_2.*扫描附件.*failed.*未配置 OCR 模型/);
    await assert.rejects(stat(join(workspace.root, 'SOURCES.md')));
    await assert.rejects(stat(join(workspace.root, 'DOCUMENTS.md')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
