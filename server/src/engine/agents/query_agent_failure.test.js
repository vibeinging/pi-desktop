import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueryFailureDetails, createQueryToolHookRegistry, terminalNaturalAnswer } from './query_agent.js';
import { buildQueryServiceModelResult, inheritQueryAgentExecutionControls } from '../skills/services/query_agent_service.js';

test('QueryAgent reports model timeout with stop reason and model turns', () => {
  const failure = buildQueryFailureDetails({
    stopReason: 'error',
    errorMessage: 'Request timed out after 120000ms',
    modelTurns: 1,
    timeoutMs: 120000,
  });

  assert.deepEqual(failure, {
    error_code: 'model_timeout',
    stop_reason: 'error',
    model_turns: 1,
    model_timeout_ms: 120000,
    model_error: 'Request timed out after 120000ms',
    message: 'QueryAgent 模型请求超时(120000ms)。',
  });
});

test('QueryAgent distinguishes model turn limit from a generic model error', () => {
  const limited = buildQueryFailureDetails({
    stopReason: 'error',
    errorMessage: '问数模型轮数超过上限(20),已停止以避免无限工具循环。',
    modelTurns: 21,
    timeoutMs: 120000,
  });
  const failed = buildQueryFailureDetails({
    stopReason: 'error',
    errorMessage: 'HTTP 503 upstream unavailable',
    modelTurns: 2,
  });

  assert.equal(limited.error_code, 'model_turn_limit');
  assert.equal(limited.stop_reason, 'error');
  assert.equal(limited.model_turns, 21);
  assert.equal(failed.error_code, 'model_error');
  assert.equal(failed.model_turns, 2);
});

test('native completion only accepts the terminal stop message, not earlier planning text', () => {
  const messages = [
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '我先查询数据' }] },
    { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '调用失败' }] },
  ];
  assert.equal(terminalNaturalAnswer(messages), '');
  messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '最终答案是 17。' }] });
  assert.equal(terminalNaturalAnswer(messages), '最终答案是 17。');
});

test('query_project_data exposes QueryAgent failure diagnostics to WorkspaceAgent', () => {
  const result = buildQueryServiceModelResult({
    status: 'failed',
    answer: '',
    warning: 'QueryAgent 模型请求超时(120000ms)。',
    error_code: 'model_timeout',
    stop_reason: 'error',
    model_turns: 1,
    model_timeout_ms: 120000,
    sources: ['kdd-structured'],
    artifacts: [],
  });

  assert.deepEqual(result, {
    status: 'failed',
    answer: '',
    warning: 'QueryAgent 模型请求超时(120000ms)。',
    error_code: 'model_timeout',
    stop_reason: 'error',
    model_turns: 1,
    model_timeout_ms: 120000,
    sources: ['kdd-structured'],
    artifacts: [],
  });
});

test('QueryAgent reuses workspace approval for write and bash tools', async () => {
  const decisions = [];
  const events = [];
  const hooks = createQueryToolHookRegistry({
    agentContext: {
      approval: 'ask',
      awaitDecision: async (id) => {
        decisions.push(id);
        return true;
      },
    },
    workspaceRoot: '/tmp/yiw-query-approval-test',
    streamCallback: async (_content, options) => events.push(options),
  });

  await hooks.beforeToolCall({ toolCall: { id: 'read-1', name: 'read' }, args: { path: 'schema.sql' } });
  await hooks.beforeToolCall({ toolCall: { id: 'write-1', name: 'write' }, args: { path: 'scripts/a.mjs' } });
  await hooks.beforeToolCall({ toolCall: { id: 'bash-1', name: 'bash' }, args: { command: 'node scripts/a.mjs' } });

  assert.deepEqual(decisions, ['write-1', 'bash-1']);
  assert.deepEqual(events.map((event) => event.title), ['write', 'approved', 'bash', 'approved']);
});

test('QueryAgent child context inherits approval and decision callback', () => {
  const awaitDecision = async () => true;
  const child = inheritQueryAgentExecutionControls({}, { approval: 'auto', awaitDecision });
  assert.equal(child.approval, 'auto');
  assert.equal(child.awaitDecision, awaitDecision);
});
