import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { APP_CONFIG } from '../../generated/app-config.js';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '../../../vendor/pi/coding-agent/dist/core/tools/index.js';
import { ModelConfigResolver } from '../core/llm.js';
import {
  appendMessages,
  ensureTranscriptProjection,
  loadTranscript,
  rewriteTranscript,
  trimToBudget,
} from './sessionStore.js';
import { assistantMessageTraceText, buildPiModel, createPiStreamFn, ensurePiProviders, normalizePiUsageForTrace } from './pi_runtime.js';
import { acquireMcpToolsForSession } from './mcp_tools.js';
import { recordTraceLlmCall, withAgentToolLifecycles } from '../trace/trace_context.js';
import {
  formatPiSkillInstructions,
  listEnabledAppSkills,
  listEnabledPiSkills,
  renderPiSkillsIndexPrompt,
} from './pi_skill_registry.js';

const CHAT_WORKSPACE_ID = '__chat__';
const WRITE_TOOLS = new Set(['write', 'edit', 'bash']);
const SKILL_CONTROL_TOOLS = new Set(['use_skill', 'update_plan']);
const DEFAULT_TOOLS = new Set(APP_CONFIG.defaultTools || []);

function isDefaultToolEnabled(toolName) {
  return DEFAULT_TOOLS.has(toolName) || (String(toolName).startsWith('mcp_') && DEFAULT_TOOLS.has('mcp_*'));
}

const SYSTEM_PROMPT = APP_CONFIG.defaultSystemPrompt;

function safeSegment(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'default';
}

export function workspaceCwd(projectId, sessionId = null) {
  const id = String(projectId || 'default');
  if (id.startsWith('folder:')) {
    try {
      const raw = id.slice('folder:'.length).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (decoded && existsSync(decoded)) return decoded;
    } catch { /* fall through */ }
  }
  if (id === CHAT_WORKSPACE_ID) {
    return join(homedir(), APP_CONFIG.dataDirName, 'projects', CHAT_WORKSPACE_ID, safeSegment(sessionId));
  }
  return join(homedir(), APP_CONFIG.dataDirName, 'projects', safeSegment(id));
}

/** 手动收缩模型上下文；界面消息仍完整保留在 SQLite。 */
export async function compactSession({ db, sessionId }) {
  if (!sessionId) return { compacted: false, message: '没有会话可压缩' };
  const transcript = await loadTranscript(db, sessionId);
  if (!Array.isArray(transcript) || transcript.length < 8) {
    return { compacted: false, message: '对话较短，无需压缩' };
  }
  const before = transcript.length;
  let start = Math.max(0, before - 6);
  while (start < before && transcript[start]?.role !== 'user') start += 1;
  const recent = transcript.slice(start < before ? start : Math.max(0, before - 4));
  const summary = {
    role: 'user',
    content: `此前 ${before - recent.length} 条上下文已手动压缩。需要早期细节时，请从会话历史中重新读取。`,
    timestamp: Date.now(),
  };
  const next = [summary, ...recent];
  await rewriteTranscript(db, sessionId, next);
  return { compacted: true, before, after: next.length };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text || part?.thinking || '').filter(Boolean).join('');
}

function resultText(result) {
  if (typeof result === 'string') return result;
  return contentText(result?.content) || '';
}

function historyBlockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'attachment') {
    const name = String(block.metadata?.name || block.content || '').trim();
    const path = String(block.metadata?.path || '').trim();
    return [name ? `附件: ${name}` : '附件', path ? `路径: ${path}` : ''].filter(Boolean).join('\n');
  }
  return String(block.content || block.text || '');
}

function historyFromRows(rows, model) {
  const messages = [];
  for (const row of rows || []) {
    let blocks = row.content_items;
    if (typeof blocks === 'string') {
      try { blocks = JSON.parse(blocks); } catch { blocks = []; }
    }
    if (Array.isArray(blocks) && blocks.some((block) => block?.type === 'compact')) continue;
    const text = (Array.isArray(blocks) ? blocks : [])
      .map(historyBlockText)
      .join('\n')
      .trim();
    if (!text) continue;
    if (row.role === 'user') messages.push({ role: 'user', content: text, timestamp: 0 });
    if (row.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 0,
      });
    }
  }
  return messages;
}

function sourceSequenceFromRows(rows) {
  let sequence = 0;
  for (const row of rows || []) {
    let blocks = row.content_items;
    if (typeof blocks === 'string') {
      try { blocks = JSON.parse(blocks); } catch { blocks = []; }
    }
    if (Array.isArray(blocks) && blocks.some((block) => block?.type === 'compact')) continue;
    if (!['user', 'assistant'].includes(row.role)) continue;
    sequence = Math.max(sequence, Number(row.sequence_number || 0));
  }
  return sequence;
}

function abortError() {
  const error = new Error('用户已停止任务');
  error.name = 'AbortError';
  return error;
}

export function isToolAllowedForSkill(toolName, skill) {
  const name = String(toolName || '');
  if (!name || SKILL_CONTROL_TOOLS.has(name) || !skill) return true;
  const allowed = Array.isArray(skill.allowed_tools) ? skill.allowed_tools.filter(Boolean) : [];
  if (allowed.length === 0) return true;
  if (allowed.includes(name)) return true;
  return name.startsWith('mcp_') && allowed.includes('mcp_*');
}

export function createBeforeToolCall({ getActiveSkill, approval, awaitDecision } = {}) {
  return async ({ toolCall }, signal) => {
    const name = toolCall?.name || '';
    const activeSkill = getActiveSkill?.() || null;
    if (!isToolAllowedForSkill(name, activeSkill)) {
      return {
        block: true,
        reason: `Skill「${activeSkill.name}」不允许使用工具「${name}」`,
      };
    }
    if ((!WRITE_TOOLS.has(name) && !name.startsWith('mcp_')) || approval === 'full') return undefined;
    if (typeof awaitDecision !== 'function') return undefined;
    const allowed = await awaitDecision({ id: toolCall.id, name, arguments: toolCall.arguments }, signal);
    if (!allowed) return { block: true, reason: '用户拒绝了该工具调用' };
    return undefined;
  };
}

export function createUseSkillTool(skills, onActivate) {
  const promptSkills = (skills || []).filter((skill) => (skill.runtime || 'prompt') === 'prompt');
  return {
    name: 'use_skill',
    description: '读取并激活一个已启用的 Prompt Skill。激活后，工具白名单会由代码强制执行。',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, params) => {
      const requested = String(params?.name || '').trim();
      const skill = promptSkills.find((item) => item.name === requested);
      if (!skill) {
        const available = promptSkills.map((item) => item.name).join(', ') || '无';
        throw new Error(`Skill「${requested}」不可用。当前可用: ${available}`);
      }
      onActivate?.(skill);
      return { content: [{ type: 'text', text: formatPiSkillInstructions(skill) }] };
    },
  };
}

/** 把 transport 的取消信号桥接到 pi Agent，后者再传给模型和工具。 */
export async function promptAgentWithSignal(agent, prompt, signal) {
  if (signal?.aborted) throw abortError();
  const abortAgent = () => agent.abort();
  signal?.addEventListener('abort', abortAgent, { once: true });
  try {
    const pending = agent.prompt(prompt);
    // 覆盖 prompt() 建立 activeRun 与外部 abort 几乎同时发生的边界。
    if (signal?.aborted) agent.abort();
    await pending;
    const lastAssistant = [...(agent.state?.messages || [])].reverse().find((item) => item?.role === 'assistant');
    return { cancelled: Boolean(signal?.aborted || lastAssistant?.stopReason === 'aborted') };
  } finally {
    signal?.removeEventListener('abort', abortAgent);
  }
}

export class WorkspaceAgent {
  constructor({ AgentClass = Agent } = {}) {
    this.AgentClass = AgentClass;
  }

  static async create(options = {}) {
    return new WorkspaceAgent(options);
  }

  async execute(context, streamCallback) {
    ensurePiProviders();
    if (context.signal?.aborted) throw abortError();
    const projectId = context.project_id;
    const sessionId = context.session_id;
    const cwd = workspaceCwd(projectId, sessionId);
    mkdirSync(cwd, { recursive: true });

    const cfg = await ModelConfigResolver.resolve({ project_id: projectId, category: 'PRIMARY' });
    if (context.signal?.aborted) throw abortError();
    const model = buildPiModel(cfg);
    const planTool = {
      name: 'update_plan',
      description: '公布或更新多步任务计划。',
      parameters: Type.Object({
        steps: Type.Array(Type.Object({ title: Type.String(), status: Type.String() })),
      }),
      execute: async (_id, params) => {
        await streamCallback(JSON.stringify(params?.steps || []), { content_id: 'plan', content_type: 'plan' });
        return { content: [{ type: 'text', text: '计划已更新' }] };
      },
    };
    const mcp = await acquireMcpToolsForSession({
      db: context.db,
      projectId,
      sessionId,
      streamCallback,
      timeoutMs: context.settings?.timeoutMs,
    });
    if (context.signal?.aborted) {
      await mcp.release();
      throw abortError();
    }
    let skills = [];
    try {
      skills = projectId === CHAT_WORKSPACE_ID || String(projectId).startsWith('folder:')
        ? await listEnabledAppSkills(context.db)
        : await listEnabledPiSkills(context.db, projectId);
    } catch { /* Skill 配置异常不阻断对话 */ }
    let activeSkill = null;
    const promptSkills = skills.filter((skill) => (skill.runtime || 'prompt') === 'prompt');
    const tools = withAgentToolLifecycles([
      planTool,
      ...(promptSkills.length ? [createUseSkillTool(promptSkills, (skill) => { activeSkill = skill; })] : []),
      createReadTool(cwd), createGrepTool(cwd), createLsTool(cwd), createFindTool(cwd),
      createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd),
      ...mcp.tools,
    ].filter((tool) => isDefaultToolEnabled(tool.name)), {
      project_id: projectId,
      session_id: sessionId,
    });
    const skillIndexPrompt = renderPiSkillsIndexPrompt(promptSkills);
    const systemPrompt = skillIndexPrompt ? `${SYSTEM_PROMPT}${skillIndexPrompt}` : SYSTEM_PROMPT;

    const historyRows = await context.loadHistory?.() || [];
    const fallbackHistory = historyFromRows(historyRows, model);
    let history = await ensureTranscriptProjection(context.db, sessionId, {
      fallbackMessages: fallbackHistory,
      sourceSequenceNumber: sourceSequenceFromRows(historyRows),
    });
    history = trimToBudget(history);
    let queuedCount = history.length;

    const agent = new this.AgentClass({
      initialState: { systemPrompt, model, tools, messages: history },
      sessionId,
      streamFn: createPiStreamFn({ apiKey: cfg.api_key, extraConfig: cfg.extra_config, timeoutMs: context.settings?.timeoutMs }),
      beforeToolCall: createBeforeToolCall({
        getActiveSkill: () => activeSkill,
        approval: context.approval,
        awaitDecision: context.awaitDecision,
      }),
    });
    context.onAgent?.(agent);

    let flushQueue = Promise.resolve();
    const flush = () => {
      const all = agent.state?.messages || [];
      if (all.length <= queuedCount) return flushQueue;
      const pending = all.slice(queuedCount);
      queuedCount = all.length;
      flushQueue = flushQueue.then(() => appendMessages(context.db, sessionId, pending));
      return flushQueue;
    };
    const args = new Map();
    let textId = randomUUID();
    let thinkingId = randomUUID();
    let turnStartedAt = Date.now();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'turn_start') {
        turnStartedAt = Date.now();
        textId = randomUUID();
        thinkingId = randomUUID();
      } else if (event.type === 'turn_end') {
        await flush();
        const usage = normalizePiUsageForTrace(event.message?.usage);
        recordTraceLlmCall({
          callSite: 'workspace_agent',
          model: model.id,
          input: context.input_data?.raw_user_message || context.input_data?.user_message || '',
          output: assistantMessageTraceText(event.message),
          usage,
          durationMs: Date.now() - turnStartedAt,
        });
        if (usage) await streamCallback('', { content_id: textId, content_type: 'markdown', usage, model: model.id });
      } else if (event.type === 'message_update') {
        const partial = event.assistantMessageEvent?.partial;
        for (const part of partial?.content || []) {
          if (part.type === 'text' && part.text) await streamCallback(part.text, { content_id: textId, content_type: 'markdown' });
          if (part.type === 'thinking' && (part.thinking || part.text)) {
            await streamCallback(part.thinking || part.text, { content_id: thinkingId, content_type: 'thinking', title: '思考' });
          }
        }
      } else if (event.type === 'tool_execution_start') {
        args.set(event.toolCallId, event.args);
        if (event.toolName !== 'update_plan') {
          await streamCallback(JSON.stringify(event.args || {}), {
            content_id: event.toolCallId,
            content_type: 'tool',
            title: 'running',
            tool_name: event.toolName,
          });
        }
      } else if (event.type === 'tool_execution_end' && event.toolName !== 'update_plan') {
        await streamCallback(resultText(event.result).slice(0, 8000), {
          content_id: event.toolCallId,
          content_type: 'tool_result',
          title: event.isError ? 'error' : 'done',
          tool_name: event.toolName,
          trace_input: JSON.stringify(args.get(event.toolCallId) || {}),
        });
      }
    });

    try {
      const result = await promptAgentWithSignal(
        agent,
        `## 当前工作区\n${cwd}\n\n## 用户消息\n${context.input_data?.user_message || ''}`,
        context.signal,
      );
      return result.cancelled ? { success: false, cancelled: true } : { success: true };
    } finally {
      unsubscribe();
      try {
        await flush();
      } finally {
        await mcp.release();
      }
    }
  }
}

export default WorkspaceAgent;
