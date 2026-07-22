import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContext } from '../core/agent_context.js';
import { buildQueryTools } from './query_tool_adapter.js';

const CODING_TOOL_NAMES = ['read', 'grep', 'ls', 'find', 'write', 'edit', 'bash'];

test('unstructured capability exposes a complete coding workspace instead of document agents', () => {
  const tools = buildQueryTools({
    agentContext: new AgentContext({ input_data: {}, data: {} }),
    session: { intermediateName: 'intermediate_test', intermediate_ds: null },
    bds: null,
    workspace: { root: '/tmp/yiw-query-workspace-test' },
    capabilities: { has_unstructured: true, has_structured: false },
    streamCallback: async () => {},
  });
  const names = tools.map((tool) => tool.name);
  for (const name of CODING_TOOL_NAMES) assert.ok(names.includes(name), `missing coding tool: ${name}`);
  assert.equal(names.includes('bash_readonly'), false);
  assert.equal(names.includes('query_documents'), false);
  assert.equal(names.includes('semantic_scan_operator'), false);
  assert.equal(names.includes('semantic_filter_operator'), false);
  assert.equal(names.includes('semantic_extract_operator'), false);
  assert.equal(names.includes('semantic_join_operator'), false);
});

test('QueryAgent does not expose metric view, metric alignment, or value alignment tools', () => {
  const tools = buildQueryTools({
    agentContext: new AgentContext({ input_data: {}, data: {} }),
    session: { intermediateName: 'intermediate_test', intermediate_ds: null },
    bds: null,
    workspace: { root: '/tmp/yiw-query-workspace-test' },
    capabilities: {
      has_structured: true,
      has_unstructured: false,
      has_metrics: true,
      has_metric_views: true,
    },
    streamCallback: async () => {},
  });
  const names = tools.map((tool) => tool.name);
  assert.equal(names.includes('metric_view_query'), false);
  assert.equal(names.includes('align_metric'), false);
  assert.equal(names.includes('align_value'), false);
  assert.equal(names.includes('sql_scan_operator'), false);
  assert.equal(names.includes('grep_tables'), false);
  assert.equal(names.includes('grep_columns'), false);
  for (const name of CODING_TOOL_NAMES) assert.ok(names.includes(name), `missing coding tool: ${name}`);
  assert.ok(names.includes('execute_sql'));
  assert.equal(names.includes('complete_sql'), false);
});

test('execute_sql produces evidence but does not terminate the agent loop', async () => {
  const context = new AgentContext({
    project_id: 'project-1',
    session_id: 'session-1',
    input_data: {},
    data: {},
  });
  const source = {
    id: 'source-1',
    source_type: 'database_connection',
    datasource_name: 'test-db',
    query: async () => ({
      success: true,
      columns: ['member_count'],
      data: [{ member_count: 17 }],
    }),
  };
  const bds = {
    get_data_source: (id) => id === source.id ? source : null,
    get_database_sources: () => [source],
  };
  const tools = buildQueryTools({
    agentContext: context,
    session: {
      intermediateName: 'intermediate_test',
      intermediate_ds: { add: async () => {} },
      resetChurn: () => {},
      recordStepOutput: () => {},
      recordIntermediateTable: async () => {},
    },
    bds,
    workspace: { root: '/tmp/yiw-query-workspace-test', sources: [{ source_id: source.id, type: 'database' }] },
    capabilities: { has_structured: true },
    streamCallback: async () => {},
  });
  const execute = tools.find((tool) => tool.name === 'execute_sql');
  const result = await execute.execute('execute-1', {
    source_id: source.id,
    sql: 'SELECT 17 AS member_count',
    question: '成员数量',
  });

  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /member_count/);
  assert.equal(context.data.tool_history.at(-1).tool, 'execute_sql');
  assert.equal(context.data.tool_history.at(-1).success, true);
  assert.equal(tools.some((tool) => tool.name === 'complete_sql'), false);
});

test('QueryAgent coding tools can write, execute, and read project code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yiw-query-coding-'));
  const context = new AgentContext({ input_data: {}, data: {} });
  try {
    const tools = buildQueryTools({
      agentContext: context,
      session: { intermediateName: 'intermediate_test', intermediate_ds: null },
      bds: null,
      workspace: { root },
      capabilities: { has_unstructured: true },
      streamCallback: async () => {},
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get('write').execute('write-1', {
      path: 'scripts/sum.mjs',
      content: 'console.log([2, 3, 5].reduce((sum, value) => sum + value, 0));\n',
    });
    const run = await byName.get('bash').execute('bash-1', { command: 'node scripts/sum.mjs' });
    const read = await byName.get('read').execute('read-1', { path: 'scripts/sum.mjs' });

    assert.match(run.content[0].text, /10/);
    assert.match(read.content[0].text, /reduce/);
    assert.match(await readFile(join(root, 'scripts/sum.mjs'), 'utf8'), /console\.log/);
    assert.deepEqual(context.data.tool_history.map((item) => item.tool), ['write', 'bash', 'read']);
    assert.ok(context.data.tool_history.every((item) => item.success));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
