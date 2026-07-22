import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutoOptimizationLoop, runAutoOptimizationRound } from '../../server/src/app/traces/trace_optimization/auto_optimizer.js';

function fixture({ passed = true } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      diagnose: async () => ({ data: { failure_stage: 'sql_generation', summary: '丢掉并列结果' } }),
      propose: async () => ({ data: { change_type: 'agent_rule', new_rule: '保留并列结果' } }),
      apply: async () => ({ data: { id: 'attempt-1', status: 'running', change_type: 'agent_rule' } }),
      verify: async () => ({ data: { run: { id: 'run-1', status: passed ? 'passed' : 'failed' } } }),
      recordVerification: async ({ passed: actual }) => { calls.push(`record:${actual}`); },
      accept: async () => { calls.push('accept'); return { data: { status: 'passed' } }; },
      rollback: async () => { calls.push('rollback'); return { data: { status: 'abandoned' } }; },
    },
  };
}

test('auto optimization accepts a trial only after Benchmark passes', async () => {
  const { calls, deps } = fixture({ passed: true });
  const result = await runAutoOptimizationRound(deps);
  assert.equal(result.status, 'completed');
  assert.equal(result.attempt.status, 'passed');
  assert.deepEqual(calls, ['record:true', 'accept']);
});

test('auto optimization precisely rolls back a failed Benchmark trial', async () => {
  const { calls, deps } = fixture({ passed: false });
  const result = await runAutoOptimizationRound(deps);
  assert.equal(result.status, 'reverted');
  assert.equal(result.attempt.status, 'abandoned');
  assert.deepEqual(calls, ['record:false', 'rollback']);
});

test('unsafe proposal stops before Benchmark', async () => {
  const { calls, deps } = fixture({ passed: true });
  deps.apply = async () => {
    const error = new Error('unsupported change');
    error.status = 400;
    throw error;
  };
  const result = await runAutoOptimizationRound(deps);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(calls, []);
});

test('auto optimization uses failed verification feedback in a later round', async () => {
  const calls = [];
  const result = await runAutoOptimizationLoop({
    maxAttempts: 3,
    async runRound({ round, previousRounds }) {
      calls.push({ round, previous: previousRounds.length });
      if (round === 1) {
        return {
          status: 'reverted',
          proposal: { new_rule: '保持明细粒度' },
          verification: { run: { status: 'failed' } },
          finalization: { status: 'abandoned' },
        };
      }
      return {
        status: 'completed',
        proposal: { new_rule: '保持明细粒度并保留并列项' },
        verification: { run: { status: 'passed' } },
        finalization: { status: 'passed' },
      };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(calls, [{ round: 1, previous: 0 }, { round: 2, previous: 1 }]);
});
