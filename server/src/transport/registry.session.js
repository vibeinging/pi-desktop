import {
  appendMessage,
  createSession,
  deleteSession,
  exportSessionTranscript,
  getSession,
  listMessages,
  listSessions,
  moveSession,
  updateSession,
} from '../app/session/index.js';

export const sessionRoutes = [
  { m: 'GET', p: '/api/projects/:pid/sessions', fn: listSessions },
  { m: 'POST', p: '/api/projects/:pid/sessions', fn: createSession },
  { m: 'GET', p: '/api/projects/:pid/sessions/:sid', fn: getSession },
  { m: 'PUT', p: '/api/projects/:pid/sessions/:sid', fn: updateSession },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/move', fn: moveSession },
  { m: 'DELETE', p: '/api/projects/:pid/sessions/:sid', fn: deleteSession },
  { m: 'GET', p: '/api/projects/:pid/sessions/:sid/transcript/export', fn: exportSessionTranscript },
  { m: 'GET', p: '/api/projects/:pid/sessions/:sid/messages', fn: listMessages },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/messages', fn: appendMessage },
];
