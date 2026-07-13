import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

function run(dbPath, source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: { ...process.env, PI_DB_PATH: dbPath },
    encoding: 'utf8',
  });
}

test('并发追加消息时序号、消息和会话计数保持一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-concurrent-messages-'));
  const dbPath = join(dir, 'local.db');
  try {
    const result = run(dbPath, `
      const db = await import('./server/src/db.js');
      const { makeCtx } = await import('./server/src/ctx.js');
      const { appendMessage } = await import('./server/src/app/session/index.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      const ctx = makeCtx();
      await Promise.all(Array.from({ length: 40 }, (_, index) => appendMessage(ctx, {
        params: { pid: 'p1', sid: 's1' },
        body: { role: index % 2 ? 'assistant' : 'user', content: String(index) },
      })));
      const messages = await db.query(
        'SELECT sequence_number FROM session_messages WHERE session_id=$1 ORDER BY sequence_number',
        ['s1'],
      );
      const session = await db.queryOne('SELECT message_count FROM sessions WHERE id=$1', ['s1']);
      console.log(JSON.stringify({ sequences: messages.map((row) => row.sequence_number), count: session.message_count }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.sequences, Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(output.count, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('移动会话前验证目标工作区存在且未删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-move-session-'));
  const dbPath = join(dir, 'local.db');
  try {
    const result = run(dbPath, `
      const db = await import('./server/src/db.js');
      const { makeCtx } = await import('./server/src/ctx.js');
      const { moveSession } = await import('./server/src/app/session/index.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','source']);
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p2','target']);
      await db.query('INSERT INTO projects (id,name,deleted_at) VALUES ($1,$2,CURRENT_TIMESTAMP)', ['p3','deleted']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      const ctx = makeCtx();
      const statuses = [];
      for (const target_project_id of ['missing', 'p3']) {
        try {
          await moveSession(ctx, { params: { pid: 'p1', sid: 's1' }, body: { target_project_id } });
        } catch (error) {
          statuses.push(error.status);
        }
      }
      const moved = await moveSession(ctx, {
        params: { pid: 'p1', sid: 's1' }, body: { target_project_id: 'p2' },
      });
      console.log(JSON.stringify({ statuses, projectId: moved.project_id }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { statuses: [404, 404], projectId: 'p2' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新数据库启用外键、字段约束和查询索引', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-schema-integrity-'));
  const dbPath = join(dir, 'local.db');
  try {
    const result = run(dbPath, `
      const db = await import('./server/src/db.js');
      const failures = [];
      try {
        await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s-missing','missing','bad']);
      } catch (error) { failures.push(error.code); }
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      try {
        await db.query('INSERT INTO session_messages (id,session_id,role,content_items,sequence_number) VALUES ($1,$2,$3,$4,$5)', ['m1','s1','invalid','[]',1]);
      } catch (error) { failures.push(error.code); }
      const foreignKeys = await db.query('PRAGMA foreign_key_list(sessions)');
      const indexes = await db.query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_sessions_project_status_deleted_updated','idx_session_messages_active_sequence','idx_agent_runs_session_created') ORDER BY name");
      console.log(JSON.stringify({ failures, foreignKeyCount: foreignKeys.length, indexes: indexes.map((row) => row.name) }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.failures, ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_CHECK']);
    assert.equal(output.foreignKeyCount, 1);
    assert.deepEqual(output.indexes, [
      'idx_agent_runs_session_created',
      'idx_session_messages_active_sequence',
      'idx_sessions_project_status_deleted_updated',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧数据库按 user_version 顺序迁移并保留现有数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-migration-'));
  const dbPath = join(dir, 'local.db');
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
      );
      CREATE TABLE llm_models (
        id TEXT PRIMARY KEY, model_name TEXT NOT NULL, display_name TEXT,
        category TEXT NOT NULL DEFAULT 'PRIMARY', api_key TEXT, api_base TEXT,
        api_format TEXT NOT NULL DEFAULT 'chat_completions', is_enabled INTEGER NOT NULL DEFAULT 1,
        extra_config TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
      );
      INSERT INTO users (id,username) VALUES ('u1','local');
      INSERT INTO projects (id,name,created_by) VALUES ('p1','legacy','u1');
      INSERT INTO llm_models (id,model_name) VALUES ('m1','legacy-model');
    `);
    legacy.close();

    const result = run(dbPath, `
      const db = await import('./server/src/db.js');
      const version = await db.queryOne('PRAGMA user_version');
      const projectColumns = await db.query('PRAGMA table_info(projects)');
      const modelColumns = await db.query('PRAGMA table_info(llm_models)');
      const users = await db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
      const project = await db.queryOne('SELECT id,name FROM projects WHERE id=$1', ['p1']);
      const model = await db.queryOne('SELECT id,model_name,project_id FROM llm_models WHERE id=$1', ['m1']);
      console.log(JSON.stringify({
        version: version.user_version,
        hasCreatedBy: projectColumns.some((column) => column.name === 'created_by'),
        hasProjectId: modelColumns.some((column) => column.name === 'project_id'),
        hasUsers: Boolean(users), project, model,
      }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      version: 2,
      hasCreatedBy: false,
      hasProjectId: true,
      hasUsers: false,
      project: { id: 'p1', name: 'legacy' },
      model: { id: 'm1', model_name: 'legacy-model', project_id: null },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移失败时不推进 user_version 且明确报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-migration-failure-'));
  const dbPath = join(dir, 'local.db');
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT CHECK (created_by <> ''),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
      );
      CREATE TABLE llm_models (
        id TEXT PRIMARY KEY, model_name TEXT NOT NULL, display_name TEXT,
        category TEXT NOT NULL DEFAULT 'PRIMARY', api_key TEXT, api_base TEXT,
        api_format TEXT NOT NULL DEFAULT 'chat_completions', is_enabled INTEGER NOT NULL DEFAULT 1,
        extra_config TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
      );
      CREATE INDEX idx_projects_created_by ON projects(created_by);
    `);
    legacy.close();

    const result = run(dbPath, `await import('./server/src/db.js');`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /数据库迁移 2 \(remove-legacy-user-columns\) 失败/);
    const reopened = new Database(dbPath);
    assert.equal(reopened.pragma('user_version', { simple: true }), 1);
    assert.ok(reopened.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'created_by'));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
