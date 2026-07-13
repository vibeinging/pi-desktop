import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
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
import { appendMessages, loadTranscript, rewriteTranscript, trimToBudget } from './sessionStore.js';
import { buildPiModel, createPiStreamFn, ensurePiProviders, normalizePiUsageForTrace } from './pi_runtime.js';
import { acquireMcpToolsForSession } from './mcp_tools.js';
import { formatPiSkillInstructions, listEnabledAppSkills, listEnabledPiSkills } from './pi_skill_registry.js';

const CHAT_WORKSPACE_ID = '__chat__';
const WRITE_TOOLS = new Set(['write', 'edit', 'bash']);

const SYSTEM_PROMPT = `你是 PI Desktop 中的通用 Agent。
使用简洁、准确的中文帮助用户完成任务。
你可以使用 read、grep、ls、find 读取工作区，使用 write、edit 修改文件，使用 bash 执行命令。
需要多步处理时，使用 update_plan 向用户展示进度。
只使用当前实际提供的工具，不虚构未配置的能力。`;

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
    return join(homedir(), '.pi-desktop', 'projects', CHAT_WORKSPACE_ID, safeSegment(sessionId));
  }
  return join(homedir(), '.pi-desktop', 'projects', safeSegment(id));
}

/** 手动收缩模型上下文；界面消息仍完整保留在 SQLite。 */
export async function compactSession({ sessionId }) {
  if (!sessionId) return { compacted: false, message: '没有会话可压缩' };
  const transcript = loadTranscript(sessionId);
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
  rewriteTranscript(sessionId, next);
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

function abortError() {
  const error = new Error('用户已停止任务');
  error.name = 'AbortError';
  return error;
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
    const tools = [
      planTool,
      createReadTool(cwd), createGrepTool(cwd), createLsTool(cwd), createFindTool(cwd),
      createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd),
      ...mcp.tools,
    ];

    let skills = [];
    try {
      skills = projectId === CHAT_WORKSPACE_ID || String(projectId).startsWith('folder:')
        ? await listEnabledAppSkills(context.db)
        : await listEnabledPiSkills(context.db, projectId);
    } catch { /* Skill 配置异常不阻断对话 */ }
    const skillPrompt = skills
      .filter((skill) => (skill.runtime || 'prompt') === 'prompt')
      .map(formatPiSkillInstructions)
      .join('\n\n---\n\n');
    const systemPrompt = skillPrompt ? `${SYSTEM_PROMPT}\n\n## 已启用 Skills\n\n${skillPrompt}` : SYSTEM_PROMPT;

    let history = loadTranscript(sessionId);
    if (!Array.isArray(history)) {
      history = historyFromRows(await context.loadHistory?.(), model);
      if (history.length) rewriteTranscript(sessionId, history);
    }
    history = trimToBudget(history);
    let persistedCount = history.length;

    const agent = new this.AgentClass({
      initialState: { systemPrompt, model, tools, messages: history },
      sessionId,
      streamFn: createPiStreamFn({ apiKey: cfg.api_key, extraConfig: cfg.extra_config, timeoutMs: context.settings?.timeoutMs }),
      beforeToolCall: async ({ toolCall }, signal) => {
        const name = toolCall?.name || '';
        if ((!WRITE_TOOLS.has(name) && !name.startsWith('mcp_')) || context.approval === 'full') return undefined;
        if (typeof context.awaitDecision !== 'function') return undefined;
        const allowed = await context.awaitDecision({ id: toolCall.id, name, arguments: toolCall.arguments }, signal);
        if (!allowed) return { block: true, reason: '用户拒绝了该工具调用' };
        return undefined;
      },
    });
    context.onAgent?.(agent);

    const flush = () => {
      const all = agent.state?.messages || [];
      if (all.length > persistedCount) {
        appendMessages(sessionId, all.slice(persistedCount));
        persistedCount = all.length;
      }
    };
    const args = new Map();
    let textId = randomUUID();
    let thinkingId = randomUUID();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'turn_start') {
        textId = randomUUID();
        thinkingId = randomUUID();
      } else if (event.type === 'turn_end') {
        flush();
        const usage = normalizePiUsageForTrace(event.message?.usage);
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
      flush();
      await mcp.release();
    }
  }
}

export default WorkspaceAgent;
