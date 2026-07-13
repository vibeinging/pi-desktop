import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.PI_DB_PATH || join(homedir(), '.pi-desktop', 'local.db');
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

export function transaction(fn) {
  return db.transaction(fn)();
}

export function closeDb() {
  if (db.open) db.close();
}

export { databasePath };
