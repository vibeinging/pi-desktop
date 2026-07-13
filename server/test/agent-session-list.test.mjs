import assert from 'node:assert/strict';
import test from 'node:test';
import { listSessions } from '../src/app/session/index.js';
import { withAgentToolLifecycle } from '../src/engine/trace/trace_context.js';

test('Agent 会话列表按项目和状态读取全部会话', async () => {
  let statement = '';
  let values = [];
  const rows = [{ id: 's1', project_id: 'p1', title: '普通会话', status: 'active' }];
  const ctx = {
    async query(sql, params) {
      statement = sql;
      values = params;
      return rows;
    },
  };

  const result = await listSessions(ctx, {
    params: { pid: 'p1' },
    query: {},
  });

  assert.deepEqual(values, ['p1', 'active']);
  assert.match(statement, /project_id=\$1/);
  assert.match(statement, /status=\$2/);
  assert.match(statement, /AS latest_run_status/);
  assert.doesNotMatch(statement, /action_type/);
  assert.doesNotMatch(statement, /ar\.deleted_at/);
  assert.equal(result.items, rows);
});

test('工具跟踪包装只包装一次', () => {
  const tool = {
    name: 'read',
    async execute() {
      return 'ok';
    },
  };

  const wrapped = withAgentToolLifecycle(tool);
  assert.equal(wrapped.__piTraceWrapped, true);
  assert.equal(withAgentToolLifecycle(wrapped), wrapped);
});
