import { agentChat } from '../app/chat/agent_chat.js';
import * as misc from '../app/chat/agent_misc.js';

export const chatRoutes = [
  { m: 'POST', p: '/api/agent/projects/:pid/sessions/:sid/chat', fn: agentChat, stream: true },
  { m: 'POST', p: '/api/agent/tool-decision', fn: misc.resolveToolDecision },
  { m: 'GET', p: '/api/agent/projects/:pid/files', fn: misc.getAgentFiles },
  { m: 'GET', p: '/api/agent/projects/:pid/file', fn: misc.getAgentFile },
  { m: 'GET', p: '/api/agent/projects/:pid/model', fn: misc.getAgentModel },
  { m: 'POST', p: '/api/agent/projects/:pid/sessions/:sid/compact', fn: misc.compactAgentSession },
  { m: 'GET', p: '/api/agent/skills', fn: misc.listAppAgentSkills },
  { m: 'GET', p: '/api/agent/skills/enabled/list', fn: misc.listEnabledAppAgentSkills },
  { m: 'GET', p: '/api/agent/skills/available-tools', fn: misc.listAppSkillAvailableTools },
  { m: 'POST', p: '/api/agent/skills/ai-generate', fn: misc.aiGenerateAppAgentSkill },
  { m: 'GET', p: '/api/agent/skills/:skillName', fn: misc.getAppAgentSkill },
  { m: 'POST', p: '/api/agent/skills', fn: misc.createAppAgentSkill },
  { m: 'PUT', p: '/api/agent/skills/:skillName', fn: misc.updateAppAgentSkill },
  { m: 'DELETE', p: '/api/agent/skills/:skillName', fn: misc.deleteAppAgentSkill },
  { m: 'PATCH', p: '/api/agent/skills/:skillName/toggle', fn: misc.toggleAppAgentSkill },
];
