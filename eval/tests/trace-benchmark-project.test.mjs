import test from 'node:test';
import assert from 'node:assert/strict';

import { caseAssertions, ensureTraceBenchmarkProject } from '../lib/trace-benchmark-task.mjs';
import { makeAssert } from '../lib/runner.mjs';

test('trace Benchmark with an existing connection never cleans project data sources', async () => {
  const calls = [];
  const driver = {
    ensureProjectRecord: async (name) => { calls.push(`record:${name}`); return 'project-1'; },
    ensureProject: async (name) => { calls.push(`clean:${name}`); return 'project-1'; },
  };
  const pid = await ensureTraceBenchmarkProject(driver, 'existing-project', { connection_id: 'connection-1' });
  assert.equal(pid, 'project-1');
  assert.deepEqual(calls, ['record:existing-project']);
});

test('trace Benchmark without replay context keeps clean-import behavior', async () => {
  const calls = [];
  const driver = {
    ensureProjectRecord: async (name) => { calls.push(`record:${name}`); return 'project-1'; },
    ensureProject: async (name) => { calls.push(`clean:${name}`); return 'project-1'; },
  };
  await ensureTraceBenchmarkProject(driver, 'generated-project', {});
  assert.deepEqual(calls, ['clean:generated-project']);
});

test('trace Benchmark list_match only scores the final answer table, not gold words in intermediate output', () => {
  const checks = makeAssert();
  const payload = {
    case: {
      answer_type: 'list',
      assertion_type: 'list_match',
      assertion: { type: 'list_match', order: 'unordered', case_sensitive: true },
      gold: { items: ['November Speaker', 'October Speaker', 'September Speaker'] },
    },
  };
  const blocks = [
    {
      type: 'tool',
      content: '完整列表含 November Speaker、October Speaker、September Speaker',
    },
    {
      type: 'markdown',
      content: '| event_name | total_cost |\n|---|---|\n| Officers meeting - November | 20.2 |\n| Officers meeting - October | 20.2 |\n| Officers meeting - September | 20.2 |',
    },
  ];

  caseAssertions(checks, payload, blocks);
  assert.equal(checks._checks.at(-1).ok, false);
  assert.match(checks._checks.at(-1).msg, /score=0/);
});

test('trace Benchmark list_match accepts an exact one-column final answer', () => {
  const checks = makeAssert();
  const payload = {
    case: {
      answer_type: 'list',
      assertion_type: 'list_match',
      assertion: { type: 'list_match', order: 'unordered', case_sensitive: true },
      gold: { items: ['November Speaker', 'October Speaker', 'September Speaker'] },
    },
  };
  const blocks = [{
    type: 'markdown',
    content: '| event_name |\n|---|\n| November Speaker |\n| October Speaker |\n| September Speaker |',
  }];

  caseAssertions(checks, payload, blocks);
  assert.equal(checks._checks.at(-1).ok, true);
});

test('trace Benchmark table_match scores every final answer column independently', () => {
  const checks = makeAssert();
  const payload = {
    case: {
      answer_type: 'table',
      assertion_type: 'table_match',
      assertion: { type: 'table_match', case_sensitive: true },
      gold: {
        columns: [{ name: 'first_name' }, { name: 'last_name' }],
        rows: [['Ava', 'Chen'], ['Noah', 'Li']],
      },
    },
  };
  const blocks = [{
    type: 'markdown',
    content: '| first_name | last_name |\n|---|---|\n| Ava | Chen |\n| Noah | Li |',
  }];

  caseAssertions(checks, payload, blocks);
  assert.equal(checks._checks.at(-1).ok, true);
});

test('trace Benchmark table_match rejects a missing final answer column', () => {
  const checks = makeAssert();
  const payload = {
    case: {
      answer_type: 'table',
      assertion_type: 'table_match',
      assertion: { type: 'table_match', case_sensitive: true },
      gold: {
        columns: [{ name: 'first_name' }, { name: 'last_name' }],
        rows: [['Ava', 'Chen'], ['Noah', 'Li']],
      },
    },
  };
  const blocks = [{
    type: 'markdown',
    content: '| full_name |\n|---|\n| Ava Chen |\n| Noah Li |',
  }];

  caseAssertions(checks, payload, blocks);
  assert.equal(checks._checks.at(-1).ok, false);
});
