import {
  deletePiSkill,
  generatePiSkillDraft,
  getPiSkill,
  listEnabledPiSkills,
  listPiSkills,
  PI_TOOL_CATALOG,
  setPiSkillEnabled,
} from '../engine/agents/pi_skill_registry.js';

const list = async (ctx, input) => ({ data: await listPiSkills(ctx, input.params.pid), message: '获取 Skill 列表成功' });
const enabled = async (ctx, input) => ({ data: await listEnabledPiSkills(ctx, input.params.pid), message: '获取启用 Skill 成功' });
const detail = async (ctx, input) => ({ data: await getPiSkill(ctx, input.params.pid, input.params.skillName), message: '获取 Skill 成功' });
const toggle = async (ctx, input) => ({
  data: await setPiSkillEnabled(
    ctx,
    input.params.pid,
    input.params.skillName,
    input.body?.enabled_override ?? input.body?.is_enabled ?? input.body?.enabled,
  ),
  message: '更新 Skill 状态成功',
});
const remove = async (ctx, input) => ({
  data: await deletePiSkill(ctx, input.params.pid, input.params.skillName),
  message: '移除 Skill 绑定成功',
});
const draft = async (_ctx, input) => ({ data: generatePiSkillDraft(input.body?.description || ''), message: '生成 Skill 草稿成功' });

export const skillRoutes = [
  { m: 'GET', p: '/api/projects/:pid/skills', fn: list },
  { m: 'GET', p: '/api/projects/:pid/skills/enabled/list', fn: enabled },
  { m: 'GET', p: '/api/projects/:pid/skills/available-tools', fn: async () => ({ data: PI_TOOL_CATALOG }) },
  { m: 'POST', p: '/api/projects/:pid/skills/ai-generate', fn: draft },
  { m: 'GET', p: '/api/projects/:pid/skills/:skillName', fn: detail },
  { m: 'PATCH', p: '/api/projects/:pid/skills/:skillName/toggle', fn: toggle },
  { m: 'DELETE', p: '/api/projects/:pid/skills/:skillName', fn: remove },
];
