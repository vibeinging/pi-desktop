import { createNote, deleteNote, listNotes } from './notes.js'

export const noteRoutes = [
  { m: 'GET', p: '/api/projects/:pid/notes', fn: listNotes },
  { m: 'POST', p: '/api/projects/:pid/notes', fn: createNote },
  { m: 'DELETE', p: '/api/projects/:pid/notes/:noteId', fn: deleteNote },
]
