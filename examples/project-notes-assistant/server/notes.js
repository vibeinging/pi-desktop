import { randomUUID } from 'node:crypto'

function abortIfNeeded(signal) {
  if (!signal?.aborted) return
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  throw error
}

function requireTitle(value) {
  const title = String(value || '').trim()
  if (!title) throw new Error('笔记标题不能为空')
  return title
}

export async function listNotes(ctx, input) {
  abortIfNeeded(ctx.signal)
  return ctx.query(
    `SELECT id,project_id,title,content,created_at,updated_at
       FROM project_notes
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
    [input.params.pid],
  )
}

export async function createNote(ctx, input) {
  abortIfNeeded(ctx.signal)
  const id = randomUUID()
  const title = requireTitle(input.body?.title)
  const content = String(input.body?.content || '')
  await ctx.query(
    'INSERT INTO project_notes (id,project_id,title,content) VALUES ($1,$2,$3,$4)',
    [id, input.params.pid, title, content],
  )
  abortIfNeeded(ctx.signal)
  return ctx.queryOne('SELECT * FROM project_notes WHERE id=$1 AND deleted_at IS NULL', [id])
}

export async function deleteNote(ctx, input) {
  abortIfNeeded(ctx.signal)
  const current = await ctx.queryOne(
    'SELECT id FROM project_notes WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',
    [input.params.noteId, input.params.pid],
  )
  if (!current) throw new Error('笔记不存在')
  await ctx.query(
    'UPDATE project_notes SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1',
    [current.id],
  )
  return { id: current.id }
}
