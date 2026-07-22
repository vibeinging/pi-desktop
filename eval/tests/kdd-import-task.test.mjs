import test from 'node:test';
import assert from 'node:assert/strict';
import { importTask } from '../lib/kdd.mjs';

test('importTask accepts a docs-only KDD context without a database connection', async () => {
  const calls = [];
  const driver = {
    async importUnstructured(pid, files, options) {
      calls.push({ pid, files, options });
      return { dsid: 'docs-1' };
    },
    async injectKnowledge() {},
  };

  const result = await importTask(driver, 'project-1', {
    db: [],
    csv: [],
    json: [],
    structured: [],
    doc: ['/tmp/a.md', '/tmp/b.md'],
    knowledge: '',
  });

  assert.equal(result.connId, undefined);
  assert.deepEqual(result.connIds, []);
  assert.deepEqual(calls, [{
    pid: 'project-1',
    files: ['/tmp/a.md', '/tmp/b.md'],
    options: { name: 'kdd-docs' },
  }]);
});

test('importTask still rejects a context with no usable data', async () => {
  await assert.rejects(
    importTask({}, 'project-1', {
      db: [],
      csv: [],
      json: [],
      structured: [],
      doc: [],
      knowledge: '',
    }),
    /task 无可导入数据源/,
  );
});
