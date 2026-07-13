import { appendSessionMessage, query, queryOne } from './db.js';

// 通用请求上下文。业务项目可通过 extras 继续扩展。
export function makeCtx({ signal = null, extras = {} } = {}) {
  return {
    signal,
    query,
    queryOne,
    appendSessionMessage,
    db: { query, queryOne, appendSessionMessage },
    ...extras,
  };
}
