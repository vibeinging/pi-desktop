import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBeforeToolCall,
  createUseSkillTool,
  isToolAllowedForSkill,
} from '../src/engine/agents/workspace_agent.js';
import { createAppSkill, updateAppSkill } from '../src/engine/agents/pi_skill_registry.js';

test('Skill 白名单允许控制工具、空白名单和明确列出的工具', () => {
  assert.equal(isToolAllowedForSkill('read', null), true);
  assert.equal(isToolAllowedForSkill('read', { allowed_tools: [] }), true);
  assert.equal(isToolAllowedForSkill('use_skill', { allowed_tools: ['read'] }), true);
  assert.equal(isToolAllowedForSkill('update_plan', { allowed_tools: ['read'] }), true);
  assert.equal(isToolAllowedForSkill('read', { allowed_tools: ['read'] }), true);
  assert.equal(isToolAllowedForSkill('write', { allowed_tools: ['read'] }), false);
});

test('Skill 白名单支持单个 MCP 工具和 mcp_* 通配项', () => {
  assert.equal(
    isToolAllowedForSkill('mcp_files_search', { allowed_tools: ['mcp_files_search'] }),
    true,
  );
  assert.equal(
    isToolAllowedForSkill('mcp_files_write', { allowed_tools: ['mcp_files_search'] }),
    false,
  );
  assert.equal(
    isToolAllowedForSkill('mcp_files_write', { allowed_tools: ['mcp_*'] }),
    true,
  );
});

test('beforeToolCall 在代码层拦截 Skill 未授权工具', async () => {
  let approvalCalls = 0;
  const guard = createBeforeToolCall({
    getActiveSkill: () => ({ name: '只读整理', allowed_tools: ['read'] }),
    approval: 'ask',
    awaitDecision: async () => {
      approvalCalls += 1;
      return true;
    },
  });

  const blocked = await guard({ toolCall: { id: '1', name: 'bash', arguments: {} } });
  assert.deepEqual(blocked, {
    block: true,
    reason: 'Skill「只读整理」不允许使用工具「bash」',
  });
  assert.equal(approvalCalls, 0);
  assert.equal(await guard({ toolCall: { id: '2', name: 'read', arguments: {} } }), undefined);
});

test('Skill 放行写工具后仍需要原有用户审批', async () => {
  const guard = createBeforeToolCall({
    getActiveSkill: () => ({ name: '文件编辑', allowed_tools: ['write'] }),
    approval: 'ask',
    awaitDecision: async () => false,
  });
  assert.deepEqual(
    await guard({ toolCall: { id: '1', name: 'write', arguments: { path: 'a.txt' } } }),
    { block: true, reason: '用户拒绝了该工具调用' },
  );
});

test('use_skill 只激活已启用的 Prompt Skill 并切换执行白名单', async () => {
  let activeSkill = null;
  const useSkill = createUseSkillTool([
    {
      name: 'reader',
      runtime: 'prompt',
      description: '读取文件',
      instructions: '只读取文件。',
      allowed_tools: ['read'],
    },
    {
      name: 'legacy-service',
      runtime: 'service',
      description: '未支持',
      instructions: '不会执行。',
      allowed_tools: [],
    },
  ], (skill) => { activeSkill = skill; });

  const result = await useSkill.execute('1', { name: 'reader' });
  assert.equal(activeSkill.name, 'reader');
  assert.match(result.content[0].text, /Skill: reader/);

  const guard = createBeforeToolCall({ getActiveSkill: () => activeSkill });
  assert.equal(await guard({ toolCall: { name: 'read' } }), undefined);
  assert.equal((await guard({ toolCall: { name: 'bash' } })).block, true);
  await assert.rejects(() => useSkill.execute('2', { name: 'legacy-service' }), /不可用/);
});

test('Server 拒绝创建或保存未实现的 Skill 运行类型', async () => {
  const unreachableCtx = {
    queryOne() {
      throw new Error('不应访问数据库');
    },
  };
  await assert.rejects(
    () => createAppSkill(unreachableCtx, { name: 'service-skill', runtime: 'service' }),
    /当前仅支持 prompt/,
  );
  await assert.rejects(
    () => updateAppSkill(unreachableCtx, 'workflow-skill', { runtime: 'workflow' }),
    /当前仅支持 prompt/,
  );
});
