import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';

const parseContent = (value) => {
  try { return JSON.parse(value || '[]'); } catch { return []; }
};

export async function listSessions(ctx, input) {
  const rows = await ctx.query(
    `SELECT sessions.*,
            (
              SELECT ar.status
                FROM agent_runs ar
               WHERE ar.session_id=sessions.id
               ORDER BY COALESCE(ar.updated_at, ar.created_at) DESC
               LIMIT 1
            ) AS latest_run_status
       FROM sessions
      WHERE project_id=$1 AND deleted_at IS NULL AND status=$2
      ORDER BY sessions.updated_at DESC`,
    [input.params.pid, input.query?.archived === 'true' ? 'archived' : 'active'],
  );
  return { items: rows };
}

export async function createSession(ctx, input) {
  const id = randomUUID();
  const title = String(input.body?.title || '新对话').trim() || '新对话';
  await ctx.query(
    'INSERT INTO sessions (id,project_id,title,status) VALUES ($1,$2,$3,$4)',
    [id, input.params.pid, title, 'active'],
  );
  return ctx.queryOne('SELECT * FROM sessions WHERE id=$1', [id]);
}

export async function getSession(ctx, input) {
  const session = await ctx.queryOne(
    'SELECT * FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',
    [input.params.sid, input.params.pid],
  );
  if (!session) throw new ApiError('会话不存在', 404);
  return session;
}

export async function updateSession(ctx, input) {
  await getSession(ctx, input);
  const title = input.body?.title;
  const status = input.body?.status;
  if (title !== undefined) await ctx.query('UPDATE sessions SET title=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [String(title), input.params.sid]);
  if (status !== undefined) await ctx.query('UPDATE sessions SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [String(status), input.params.sid]);
  return getSession(ctx, input);
}

export async function moveSession(ctx, input) {
  await getSession(ctx, input);
  const targetProjectId = String(input.body?.target_project_id || '').trim();
  if (!targetProjectId) throw new ApiError('目标工作区不能为空');
  const targetProject = await ctx.queryOne(
    'SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL',
    [targetProjectId],
  );
  if (!targetProject) throw new ApiError('目标工作区不存在', 404);
  await ctx.query(
    'UPDATE sessions SET project_id=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',
    [targetProjectId, input.params.sid],
  );
  return ctx.queryOne('SELECT * FROM sessions WHERE id=$1', [input.params.sid]);
}

export async function persistSessionMessage(ctx, {
  id = randomUUID(),
  sessionId,
  role,
  contentItems,
  metadata = {},
  parentMessageId = null,
}) {
  const payload = {
    id,
    sessionId,
    role,
    contentItems: JSON.stringify(contentItems),
    metadata: JSON.stringify(metadata),
    parentMessageId,
  };
  const atomicAppend = ctx.appendSessionMessage || ctx.db?.appendSessionMessage;
  if (typeof atomicAppend === 'function') {
    return atomicAppend(payload);
  }

  // 单元测试可传轻量 fake ctx；生产 makeCtx 始终提供上面的原子写入函数。
  const last = await ctx.queryOne(
    'SELECT COALESCE(MAX(sequence_number),0) AS seq FROM session_messages WHERE session_id=$1',
    [sessionId],
  );
  const sequenceNumber = Number(last?.seq || 0) + 1;
  await ctx.query(
    `INSERT INTO session_messages
      (id,session_id,role,content_items,message_metadata,sequence_number,parent_message_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, sessionId, role, payload.contentItems, payload.metadata, sequenceNumber, parentMessageId],
  );
  await ctx.query(
    'UPDATE sessions SET message_count=message_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1',
    [sessionId],
  );
  return { id, sequence_number: sequenceNumber };
}

export async function deleteSession(ctx, input) {
  await getSession(ctx, input);
  await ctx.query('UPDATE sessions SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [input.params.sid]);
  return { id: input.params.sid };
}

export async function listMessages(ctx, input) {
  await getSession(ctx, input);
  const rows = await ctx.query(
    `SELECT * FROM session_messages
      WHERE session_id=$1 AND deleted_at IS NULL
      ORDER BY sequence_number ASC`,
    [input.params.sid],
  );
  return { items: rows.map((row) => ({ ...row, content_items: parseContent(row.content_items) })) };
}

export async function appendMessage(ctx, input) {
  await getSession(ctx, input);
  const role = String(input.body?.role || 'user');
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) throw new ApiError('消息角色无效');
  const content = Array.isArray(input.body?.content_items)
    ? input.body.content_items
    : [{ type: 'text', content: String(input.body?.content || '') }];
  const persisted = await persistSessionMessage(ctx, {
    sessionId: input.params.sid,
    role,
    contentItems: content,
    metadata: input.body?.metadata || {},
    parentMessageId: input.body?.parent_message_id || null,
  });
  return { ...persisted, role, content_items: content };
}
