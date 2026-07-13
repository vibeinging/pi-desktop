import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';
import { WorkspaceAgent } from '../../engine/agents/workspace_agent.js';
import { createStreamEvent, StreamEventType, StreamVisibility } from '../../transport/agent_stream_protocol.js';
import { pendingDecisions } from './agent_misc.js';
import { persistSessionMessage } from '../session/index.js';
import {
  buildAttachmentContextMessage,
  buildUserContentItems,
  normalizeMessageAttachments,
} from './message_blocks.js';

export async function agentChat(ctx, input, emit) {
  const projectId = input.params.pid;
  const sessionId = input.params.sid;
  const message = String(input.body?.message || '').trim();
  const attachments = normalizeMessageAttachments(input.body?.attachments);
  if (!message && !attachments.length) throw new ApiError('请输入内容');
  const session = await ctx.queryOne(
    'SELECT * FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',
    [sessionId, projectId],
  );
  if (!session) throw new ApiError('会话不存在', 404);

  const runId = randomUUID();
  const messageId = randomUUID();
  let seq = 0;
  const assistantBlocks = new Map();
  const userMessage = await persistSessionMessage(ctx, {
    sessionId,
    role: 'user',
    contentItems: buildUserContentItems(message, attachments),
    metadata: attachments.length ? { attachments } : {},
  });
  const userMessageId = userMessage.id;
  await ctx.query(
    'INSERT INTO agent_runs (id,session_id,project_id,status,mode) VALUES ($1,$2,$3,$4,$5)',
    [runId, sessionId, projectId, 'running', 'workspace'],
  );
  emit(createStreamEvent({ type: StreamEventType.RUN_STARTED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.HIDDEN, payload: { status: 'running' } }));

  const callback = async (content, meta = {}) => {
    const type = meta.content_type || 'markdown';
    const blockId = String(meta.content_id || randomUUID());
    if (['markdown', 'text'].includes(type) && content) assistantBlocks.set(blockId, { type, content: String(content) });
    if (type === 'plan') {
      let steps = [];
      try { steps = JSON.parse(content); } catch { /* keep empty */ }
      emit(createStreamEvent({ type: StreamEventType.PLAN_UPDATED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.SECONDARY, payload: { steps } }));
      return;
    }
    if (type === 'tool') {
      emit(createStreamEvent({ type: meta.title === 'error' ? StreamEventType.TOOL_FAILED : meta.title === 'done' ? StreamEventType.TOOL_COMPLETED : StreamEventType.TOOL_STARTED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.SECONDARY, payload: { tool_call_id: blockId, name: meta.tool_name, status: meta.title, args_preview: content } }));
      return;
    }
    if (type === 'tool_result') {
      emit(createStreamEvent({ type: StreamEventType.TOOL_OUTPUT, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.SECONDARY, payload: { tool_call_id: blockId, name: meta.tool_name, result_preview: content } }));
      return;
    }
    emit(createStreamEvent({
      type: StreamEventType.MESSAGE_DELTA,
      runId, sessionId, messageId, seq: ++seq,
      visibility: type === 'thinking' ? StreamVisibility.SECONDARY : StreamVisibility.PRIMARY,
      payload: { block_id: blockId, channel: type === 'thinking' ? 'thinking' : 'answer', format: type, mode: 'replace', content, title: meta.title, usage: meta.usage, model: meta.model },
    }));
  };

  try {
    const agent = await WorkspaceAgent.create();
    const result = await agent.execute({
      project_id: projectId,
      session_id: sessionId,
      input_data: {
        user_message: buildAttachmentContextMessage(message, attachments),
        raw_user_message: message,
        attachments,
      },
      db: { query: ctx.query, queryOne: ctx.queryOne },
      signal: ctx.signal,
      approval: input.body?.approval || 'ask',
      settings: input.body?.settings || {},
      awaitDecision: ({ id, name, arguments: args }) => new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (approved) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', abortDecision);
          if (pendingDecisions.get(id) === finish) pendingDecisions.delete(id);
          resolve(Boolean(approved));
        };
        const abortDecision = () => finish(false);
        if (ctx.signal?.aborted) {
          finish(false);
          return;
        }
        timer = setTimeout(() => finish(false), 5 * 60 * 1000);
        timer.unref?.();
        pendingDecisions.set(id, finish);
        ctx.signal?.addEventListener('abort', abortDecision, { once: true });
        emit(createStreamEvent({
          type: StreamEventType.APPROVAL_REQUESTED,
          runId,
          sessionId,
          messageId,
          seq: ++seq,
          visibility: StreamVisibility.ACTION,
          payload: { tool_call_id: id, name, arguments: args || {} },
        }));
      }),
      loadHistory: () => ctx.query(
        'SELECT role,content_items FROM session_messages WHERE session_id=$1 AND id<>$2 AND deleted_at IS NULL ORDER BY sequence_number',
        [sessionId, userMessageId],
      ),
    }, callback);
    if (ctx.signal?.aborted || result?.cancelled) {
      await ctx.query('UPDATE agent_runs SET status=$1,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2', ['cancelled', runId]);
      emit(createStreamEvent({ type: StreamEventType.RUN_CANCELLED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.HIDDEN, payload: { status: 'cancelled' } }));
      return { success: false, cancelled: true };
    }
    const blocks = [...assistantBlocks.values()];
    if (blocks.length) {
      await persistSessionMessage(ctx, {
        sessionId,
        role: 'assistant',
        contentItems: blocks,
        metadata: { run_id: runId },
      });
    }
    await ctx.query('UPDATE agent_runs SET status=$1,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2', ['completed', runId]);
    emit(createStreamEvent({ type: StreamEventType.RUN_COMPLETED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.HIDDEN, payload: { status: 'completed' } }));
    return { success: true };
  } catch (error) {
    if (ctx.signal?.aborted || error?.name === 'AbortError') {
      await ctx.query('UPDATE agent_runs SET status=$1,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$2', ['cancelled', runId]);
      emit(createStreamEvent({ type: StreamEventType.RUN_CANCELLED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.HIDDEN, payload: { status: 'cancelled' } }));
      return { success: false, cancelled: true };
    }
    await ctx.query('UPDATE agent_runs SET status=$1,finished_at=CURRENT_TIMESTAMP,metadata_json=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3', ['failed', JSON.stringify({ error: error?.message || String(error) }), runId]);
    emit(createStreamEvent({ type: StreamEventType.RUN_FAILED, runId, sessionId, messageId, seq: ++seq, visibility: StreamVisibility.PRIMARY, payload: { status: 'failed', message: error?.message || String(error) } }));
    throw error;
  }
}
