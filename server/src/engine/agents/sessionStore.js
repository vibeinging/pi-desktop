/**
 * 会话运行数据只写 SQLite，不再同时维护 JSONL。
 *
 * `session_messages` 是给人查看的权威历史；`agent_transcript_messages` 是给 Agent 使用、
 * 可从权威历史恢复的完整上下文投影，两者用途不同。
 * 老版本 JSONL 只会导入一次，之后改名为 `.migrated`，不再参与日常读写。
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { APP_CONFIG } from "../../generated/app-config.js";

const DIR = join(homedir(), APP_CONFIG.dataDirName, "agent-sessions");
const VERSION = 1;
const sessionOperationTails = new Map();

function fileFor(sessionId) {
  const safe = String(sessionId || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
  return join(DIR, `${safe}.jsonl`);
}

function headerLine(sessionId) {
  return JSON.stringify({ type: "session", version: VERSION, id: String(sessionId) }) + "\n";
}

function requireStore(db) {
  if (!db) throw new Error("缺少 SQLite transcript store");
  return db;
}

/** 同一会话的 Agent、压缩和删除必须串行，避免上下文互相覆盖。 */
export async function withSessionLock(sessionId, operation, { signal } = {}) {
  const key = String(sessionId || "");
  if (!key) throw new Error("会话不能为空");
  const previous = sessionOperationTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  sessionOperationTails.set(key, tail);
  await previous.catch(() => {});
  if (signal?.aborted) {
    release();
    if (sessionOperationTails.get(key) === tail) sessionOperationTails.delete(key);
    const error = new Error("用户已停止任务");
    error.name = "AbortError";
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
    if (sessionOperationTails.get(key) === tail) sessionOperationTails.delete(key);
  }
}

async function loadFromDb(db, sessionId) {
  const store = requireStore(db);
  if (typeof store.loadAgentTranscript === "function") {
    return await store.loadAgentTranscript(sessionId);
  }
  if (typeof store.query !== "function") throw new Error("SQLite transcript store 不支持读取");
  const rows = await store.query(
    `SELECT message_json FROM agent_transcript_messages
      WHERE session_id=$1 ORDER BY sequence_number`,
    [sessionId],
  );
  if (!rows.length) return null;
  return rows.map((row) => JSON.parse(row.message_json));
}

function readLegacyTranscript(sessionId) {
  const path = fileFor(sessionId);
  if (!existsSync(path)) return null;
  const messages = [];
  let invalidLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const value = line.trim();
    if (!value) continue;
    let entry;
    try {
      entry = JSON.parse(value);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (entry?.type === "session") continue;
    if (entry?.type === "message" && entry.message) messages.push(entry.message);
    else invalidLines += 1;
  }
  return { path, messages, invalidLines };
}

function markLegacyMigrated(path) {
  let target = `${path}.migrated`;
  if (existsSync(target)) target = `${target}-${Date.now()}`;
  renameSync(path, target);
  return target;
}

/** 优先读取 SQLite；为空时只导入一次老 JSONL。 */
export async function loadTranscript(db, sessionId) {
  if (!sessionId) return null;
  const current = await loadFromDb(db, sessionId);
  if (Array.isArray(current)) return current;
  const legacy = readLegacyTranscript(sessionId);
  if (!legacy) return null;
  if (legacy.invalidLines) {
    console.warn(`[session transcript] ${sessionId} 跳过 ${legacy.invalidLines} 条损坏 JSONL`);
  }
  if (legacy.messages.length) await rewriteTranscript(db, sessionId, legacy.messages);
  try {
    markLegacyMigrated(legacy.path);
  } catch (error) {
    // SQLite 已经写入成功，旧文件改名失败不能反过来让会话不可用。
    console.warn(`[session transcript] ${sessionId} 旧 JSONL 改名失败: ${error?.message || error}`);
  }
  return legacy.messages.length ? legacy.messages : null;
}

/** 追加若干原始 AgentMessage；失败必须向上抛出，不能静默丢历史。 */
export async function appendMessages(db, sessionId, messages) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) return { count: 0 };
  const store = requireStore(db);
  if (typeof store.appendAgentTranscript !== "function") {
    throw new Error("SQLite transcript store 不支持原子追加");
  }
  return await store.appendAgentTranscript({ sessionId, messages });
}

/** 整份重写，用于压缩检查点、旧会话引导和工具结果修复。 */
export async function rewriteTranscript(db, sessionId, messages) {
  if (!sessionId || !Array.isArray(messages)) throw new Error("会话和消息不能为空");
  const store = requireStore(db);
  if (typeof store.replaceAgentTranscript !== "function") {
    throw new Error("SQLite transcript store 不支持原子重写");
  }
  return await store.replaceAgentTranscript({ sessionId, messages });
}

async function loadProjectionState(db, sessionId) {
  const store = requireStore(db);
  if (typeof store.getAgentTranscriptState === "function") {
    return await store.getAgentTranscriptState(sessionId);
  }
  if (typeof store.queryOne !== "function") return null;
  return await store.queryOne(
    `SELECT session_id,source_sequence_number,revision,updated_at
       FROM agent_transcript_state WHERE session_id=$1`,
    [sessionId],
  );
}

async function markProjectionSynchronized(db, sessionId, sourceSequenceNumber) {
  const store = requireStore(db);
  if (typeof store.markAgentTranscriptSynchronized === "function") {
    return await store.markAgentTranscriptSynchronized(sessionId, sourceSequenceNumber);
  }
  if (typeof store.query !== "function") return null;
  await store.query(
    `INSERT INTO agent_transcript_state
      (session_id,source_sequence_number,revision,updated_at)
     VALUES ($1,$2,0,CURRENT_TIMESTAMP)
     ON CONFLICT(session_id) DO UPDATE SET
       source_sequence_number=excluded.source_sequence_number,
       updated_at=CURRENT_TIMESTAMP`,
    [sessionId, Math.max(0, Number(sourceSequenceNumber || 0))],
  );
  return null;
}

/**
 * `session_messages` 是权威历史，Agent transcript 是可重建投影。
 * 投影落后时从界面历史重建；升级后首次看到旧 transcript 时先信任并建立基线。
 */
export async function ensureTranscriptProjection(db, sessionId, {
  fallbackMessages = [],
  sourceSequenceNumber = 0,
} = {}) {
  const current = await loadTranscript(db, sessionId);
  const state = await loadProjectionState(db, sessionId);
  const sourceSequence = Math.max(0, Number(sourceSequenceNumber || 0));
  if (state && Number(state.source_sequence_number || 0) === sourceSequence && Array.isArray(current)) {
    return current;
  }

  // 兼容升级：旧 JSONL 或 v3 SQLite transcript 首次读到时保留完整工具上下文，
  // 之后由 source_sequence_number 检查新产生的漂移。
  if (!state && Array.isArray(current)) {
    await markProjectionSynchronized(db, sessionId, sourceSequence);
    return current;
  }

  const messages = Array.isArray(fallbackMessages) ? fallbackMessages : [];
  const store = requireStore(db);
  if (typeof store.replaceAgentTranscriptProjection === "function") {
    await store.replaceAgentTranscriptProjection({
      sessionId,
      messages,
      sourceSequenceNumber: sourceSequence,
    });
  } else {
    await rewriteTranscript(db, sessionId, messages);
    await markProjectionSynchronized(db, sessionId, sourceSequence);
  }
  return messages;
}

export async function replaceToolResultText(db, sessionId, toolCallId, text, details = {}) {
  const messages = await loadTranscript(db, sessionId);
  if (!Array.isArray(messages) || !toolCallId) return false;
  let changed = false;
  const next = messages.map((message) => {
    if (message?.role !== "toolResult" || message.toolCallId !== toolCallId) return message;
    changed = true;
    return {
      ...message,
      content: [{ type: "text", text: String(text || "") }],
      details: { ...(message.details || {}), ...details },
      isError: false,
      timestamp: Date.now(),
    };
  });
  if (!changed) return false;
  await rewriteTranscript(db, sessionId, next);
  return true;
}

export function deleteLegacyTranscript(sessionId) {
  const path = fileFor(sessionId);
  if (existsSync(path)) rmSync(path, { force: true });
  if (!existsSync(DIR)) return;
  const prefix = `${basename(path)}.migrated`;
  for (const name of readdirSync(DIR)) {
    if (name.startsWith(prefix)) rmSync(join(DIR, name), { force: true });
  }
}

export async function exportTranscriptJsonl(db, sessionId) {
  const messages = await loadTranscript(db, sessionId) || [];
  return headerLine(sessionId) + messages
    .map((message) => JSON.stringify({ type: "message", message }))
    .join("\n") + (messages.length ? "\n" : "");
}

/**
 * 体量预算裁剪(喂给 LLM 前的兜底,不改文件):总体量超 maxChars 时只在 user 边界切窗,
 * 保证窗口要么为空、要么以 user 起头(不悬空 toolResult)。compaction 是主力,这是保险丝。
 */
export function trimToBudget(messages, maxChars = 200000) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  // 单遍:各消息体量算一次 → 反向前缀和。窗口只在 user 边界切,保证以 user 起头(不悬空 toolResult)。
  const sz = new Array(messages.length);
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    try {
      sz[i] = JSON.stringify(messages[i]).length;
    } catch {
      sz[i] = 0;
    }
    total += sz[i];
  }
  if (total <= maxChars) return messages;

  // 从尾部累加,记录「从此处到末尾」体量;遇到 user 且窗口仍在预算内 → 记为可行起点(取最早可行)。
  let suffix = 0;
  let bestUser = -1; // 能放进预算的最早 user 起点
  let recentUser = -1; // 最近(最大下标)的 user —— 兜底:都放不下时取最小窗口
  for (let i = messages.length - 1; i >= 0; i--) {
    suffix += sz[i];
    if (messages[i]?.role === "user") {
      if (recentUser === -1) recentUser = i; // 反向扫描首个命中 = 最大下标
      if (suffix <= maxChars) bestUser = i;
    }
  }
  if (bestUser >= 0) return messages.slice(bestUser);
  if (recentUser >= 0) return messages.slice(recentUser);
  return []; // 没有 user 边界 → 无法安全重放
}
