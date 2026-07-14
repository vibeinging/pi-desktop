import {
  appendAgentTranscript,
  appendSessionMessage,
  completeAgentRunAndSync,
  deleteSessionData,
  getAgentTranscriptState,
  loadAgentTranscript,
  markAgentTranscriptSynchronized,
  query,
  queryOne,
  replaceAgentTranscript,
  replaceAgentTranscriptProjection,
} from './db.js';

// 通用请求上下文。业务项目可通过 extras 继续扩展。
export function makeCtx({ signal = null, extras = {} } = {}) {
  return {
    signal,
    query,
    queryOne,
    appendSessionMessage,
    appendAgentTranscript,
    replaceAgentTranscript,
    replaceAgentTranscriptProjection,
    loadAgentTranscript,
    getAgentTranscriptState,
    markAgentTranscriptSynchronized,
    completeAgentRunAndSync,
    deleteSessionData,
    db: {
      query,
      queryOne,
      appendSessionMessage,
      appendAgentTranscript,
      replaceAgentTranscript,
      replaceAgentTranscriptProjection,
      loadAgentTranscript,
      getAgentTranscriptState,
      markAgentTranscriptSynchronized,
      completeAgentRunAndSync,
      deleteSessionData,
    },
    ...extras,
  };
}
