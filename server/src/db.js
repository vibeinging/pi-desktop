import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG } from './generated/app-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.PI_DB_PATH || join(homedir(), APP_CONFIG.dataDirName, 'local.db');
mkdirSync(dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8'));

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dropColumnIfExists(table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

const migrations = [
  {
    version: 1,
    name: 'add-project-scoped-models',
    up() {
      ensureColumn('llm_models', 'project_id', 'TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_models_resolution
        ON llm_models(project_id, category, is_enabled, deleted_at, created_at DESC)`);
    },
  },
  {
    version: 2,
    name: 'remove-legacy-user-columns',
    up() {
      for (const [table, column] of [
        ['projects', 'created_by'],
        ['sessions', 'created_by'],
        ['agent_runs', 'user_id'],
        ['agent_pending_inputs', 'user_id'],
        ['agent_pending_inputs', 'responded_by'],
        ['app_skills', 'created_by'],
        ['app_skills', 'updated_by'],
        ['app_skills', 'deleted_by'],
        ['project_skills', 'enabled_by'],
        ['project_skills', 'deleted_by'],
        ['app_mcp_providers', 'created_by'],
        ['app_mcp_providers', 'updated_by'],
        ['app_mcp_providers', 'deleted_by'],
        ['project_mcp_providers', 'enabled_by'],
        ['project_mcp_providers', 'deleted_by'],
      ]) dropColumnIfExists(table, column);
      db.exec('DROP TABLE IF EXISTS users');
    },
  },
  {
    version: 3,
    name: 'add-agent-transcript-messages',
    up() {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_transcript_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
        message_json TEXT NOT NULL CHECK (json_valid(message_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, sequence_number)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_transcript_session_sequence
        ON agent_transcript_messages(session_id, sequence_number)`);
    },
  },
  {
    version: 4,
    name: 'add-agent-transcript-projection-state',
    up() {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_transcript_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
        source_sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence_number >= 0),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
];

function runMigrations() {
  let currentVersion = Number(db.pragma('user_version', { simple: true }) || 0);
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    try {
      db.transaction(() => {
        migration.up();
        db.pragma(`user_version = ${migration.version}`);
      }).immediate();
      currentVersion = migration.version;
    } catch (error) {
      throw new Error(`数据库迁移 ${migration.version} (${migration.name}) 失败: ${error?.message || error}`, { cause: error });
    }
  }
}

runMigrations();

function normalize(sql, params = []) {
  const order = [];
  const text = String(sql)
    .replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\$(\d+)/g, (_match, index) => {
      order.push(Number(index) - 1);
      return '?';
    });
  return { text, values: order.length ? order.map((index) => params[index]) : params };
}

export async function query(sql, params = []) {
  const { text, values } = normalize(sql, params);
  const statement = db.prepare(text);
  if (statement.reader) return statement.all(...values);
  const result = statement.run(...values);
  return { rowCount: result.changes, lastInsertRowid: result.lastInsertRowid };
}

export async function queryOne(sql, params = []) {
  const { text, values } = normalize(sql, params);
  return db.prepare(text).get(...values) || null;
}

const appendSessionMessageTransaction = db.transaction(({
  id,
  sessionId,
  role,
  contentItems,
  metadata,
  parentMessageId = null,
}) => {
  const last = db.prepare(
    'SELECT COALESCE(MAX(sequence_number),0) AS seq FROM session_messages WHERE session_id=?',
  ).get(sessionId);
  const sequenceNumber = Number(last?.seq || 0) + 1;
  db.prepare(
    `INSERT INTO session_messages
      (id,session_id,role,content_items,message_metadata,sequence_number,parent_message_id)
      VALUES (?,?,?,?,?,?,?)`,
  ).run(id, sessionId, role, contentItems, metadata, sequenceNumber, parentMessageId);
  const updated = db.prepare(
    `UPDATE sessions
        SET message_count=message_count+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND deleted_at IS NULL`,
  ).run(sessionId);
  if (updated.changes !== 1) throw new Error('会话不存在或已删除');
  return { id, sequence_number: sequenceNumber };
});

// 生产请求统一走这一同步事务，避免并发消息拿到相同序号或 message_count 少计。
export function appendSessionMessage(message) {
  return appendSessionMessageTransaction.immediate(message);
}

function requireActiveSession(sessionId) {
  const session = db.prepare('SELECT id FROM sessions WHERE id=? AND deleted_at IS NULL').get(sessionId);
  if (!session) throw new Error('会话不存在或已删除');
}

const appendAgentTranscriptTransaction = db.transaction(({ sessionId, messages }) => {
  requireActiveSession(sessionId);
  const last = db.prepare(
    'SELECT COALESCE(MAX(sequence_number),0) AS seq FROM agent_transcript_messages WHERE session_id=?',
  ).get(sessionId);
  let sequenceNumber = Number(last?.seq || 0);
  const insert = db.prepare(
    `INSERT INTO agent_transcript_messages (session_id,sequence_number,message_json)
     VALUES (?,?,?)`,
  );
  for (const message of messages) {
    sequenceNumber += 1;
    insert.run(sessionId, sequenceNumber, JSON.stringify(message));
  }
  db.prepare(
    `UPDATE agent_transcript_state
        SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE session_id=?`,
  ).run(sessionId);
  return { count: messages.length, last_sequence_number: sequenceNumber };
});

export function appendAgentTranscript({ sessionId, messages }) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
    return { count: 0, last_sequence_number: 0 };
  }
  return appendAgentTranscriptTransaction.immediate({ sessionId, messages });
}

const replaceAgentTranscriptTransaction = db.transaction(({ sessionId, messages }) => {
  requireActiveSession(sessionId);
  db.prepare('DELETE FROM agent_transcript_messages WHERE session_id=?').run(sessionId);
  const insert = db.prepare(
    `INSERT INTO agent_transcript_messages (session_id,sequence_number,message_json)
     VALUES (?,?,?)`,
  );
  messages.forEach((message, index) => {
    insert.run(sessionId, index + 1, JSON.stringify(message));
  });
  db.prepare(
    `UPDATE agent_transcript_state
        SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE session_id=?`,
  ).run(sessionId);
  return { count: messages.length };
});

export function replaceAgentTranscript({ sessionId, messages }) {
  if (!sessionId || !Array.isArray(messages)) throw new Error('会话和消息不能为空');
  return replaceAgentTranscriptTransaction.immediate({ sessionId, messages });
}

export function loadAgentTranscript(sessionId) {
  if (!sessionId) return null;
  const rows = db.prepare(
    `SELECT message_json FROM agent_transcript_messages
      WHERE session_id=? ORDER BY sequence_number`,
  ).all(sessionId);
  if (!rows.length) return null;
  return rows.map((row) => JSON.parse(row.message_json));
}

export function getAgentTranscriptState(sessionId) {
  if (!sessionId) return null;
  return db.prepare(
    `SELECT session_id,source_sequence_number,revision,updated_at
       FROM agent_transcript_state WHERE session_id=?`,
  ).get(sessionId) || null;
}

function upsertAgentTranscriptState(sessionId, sourceSequenceNumber, { incrementRevision = false } = {}) {
  db.prepare(
    `INSERT INTO agent_transcript_state
      (session_id,source_sequence_number,revision,updated_at)
     VALUES (?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(session_id) DO UPDATE SET
       source_sequence_number=excluded.source_sequence_number,
       revision=agent_transcript_state.revision+?,
       updated_at=CURRENT_TIMESTAMP`,
  ).run(
    sessionId,
    Math.max(0, Number(sourceSequenceNumber || 0)),
    incrementRevision ? 1 : 0,
    incrementRevision ? 1 : 0,
  );
}

export function markAgentTranscriptSynchronized(sessionId, sourceSequenceNumber) {
  requireActiveSession(sessionId);
  upsertAgentTranscriptState(sessionId, sourceSequenceNumber);
  return getAgentTranscriptState(sessionId);
}

const replaceAgentTranscriptProjectionTransaction = db.transaction(({
  sessionId,
  messages,
  sourceSequenceNumber,
}) => {
  requireActiveSession(sessionId);
  db.prepare('DELETE FROM agent_transcript_messages WHERE session_id=?').run(sessionId);
  const insert = db.prepare(
    `INSERT INTO agent_transcript_messages (session_id,sequence_number,message_json)
     VALUES (?,?,?)`,
  );
  messages.forEach((message, index) => {
    insert.run(sessionId, index + 1, JSON.stringify(message));
  });
  upsertAgentTranscriptState(sessionId, sourceSequenceNumber, { incrementRevision: true });
  return { count: messages.length, state: getAgentTranscriptState(sessionId) };
});

export function replaceAgentTranscriptProjection({ sessionId, messages, sourceSequenceNumber }) {
  if (!sessionId || !Array.isArray(messages)) throw new Error('会话和消息不能为空');
  return replaceAgentTranscriptProjectionTransaction.immediate({
    sessionId,
    messages,
    sourceSequenceNumber,
  });
}

const completeAgentRunAndSyncTransaction = db.transaction(({
  runId,
  sessionId,
  sourceSequenceNumber,
}) => {
  requireActiveSession(sessionId);
  const updated = db.prepare(
    `UPDATE agent_runs
        SET status='completed',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND session_id=?`,
  ).run(runId, sessionId);
  if (updated.changes !== 1) throw new Error('Agent 运行记录不存在');
  upsertAgentTranscriptState(sessionId, sourceSequenceNumber);
  return { id: runId, status: 'completed' };
});

export function completeAgentRunAndSync(input) {
  return completeAgentRunAndSyncTransaction.immediate(input);
}

const deleteSessionDataTransaction = db.transaction((sessionId) => {
  requireActiveSession(sessionId);
  db.prepare('DELETE FROM agent_pending_inputs WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM agent_runs WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM session_messages WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM agent_transcript_messages WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM agent_transcript_state WHERE session_id=?').run(sessionId);
  const updated = db.prepare(
    `UPDATE sessions
        SET message_count=0,deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND deleted_at IS NULL`,
  ).run(sessionId);
  if (updated.changes !== 1) throw new Error('会话不存在或已删除');
  return { id: sessionId };
});

export function deleteSessionData(sessionId) {
  return deleteSessionDataTransaction.immediate(sessionId);
}

export function transaction(fn) {
  return db.transaction(fn)();
}

export function closeDb() {
  if (db.open) db.close();
}

export { databasePath };
