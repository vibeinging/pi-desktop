import assert from 'node:assert/strict'
import test from 'node:test'
import { createNote, deleteNote, listNotes } from './notes.js'

function createCtx(signal = null) {
  const notes = []
  return {
    notes,
    signal,
    async query(sql, params) {
      if (sql.includes('INSERT INTO project_notes')) {
        notes.push({ id: params[0], project_id: params[1], title: params[2], content: params[3], deleted_at: null })
      } else if (sql.includes('UPDATE project_notes SET deleted_at')) {
        notes.find((note) => note.id === params[0]).deleted_at = new Date().toISOString()
      } else if (sql.includes('FROM project_notes')) {
        return notes.filter((note) => note.project_id === params[0] && !note.deleted_at)
      }
      return { rowCount: 1 }
    },
    async queryOne(sql, params) {
      if (sql.includes('project_id=$2')) return notes.find((note) => note.id === params[0] && note.project_id === params[1] && !note.deleted_at) || null
      return notes.find((note) => note.id === params[0] && !note.deleted_at) || null
    },
  }
}

test('笔记可以创建、读取和软删除', async () => {
  const ctx = createCtx()
  const created = await createNote(ctx, { params: { pid: 'p1' }, body: { title: '计划', content: '第一版' } })
  assert.equal(created.title, '计划')
  assert.equal((await listNotes(ctx, { params: { pid: 'p1' } })).length, 1)
  await deleteNote(ctx, { params: { pid: 'p1', noteId: created.id } })
  assert.equal((await listNotes(ctx, { params: { pid: 'p1' } })).length, 0)
})

test('空标题和取消信号会明确失败', async () => {
  await assert.rejects(createNote(createCtx(), { params: { pid: 'p1' }, body: { title: ' ' } }), /标题不能为空/)
  await assert.rejects(listNotes(createCtx(AbortSignal.abort()), { params: { pid: 'p1' } }), { name: 'AbortError' })
})
