import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

function run(dbPath, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: { ...process.env, PI_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('会话和消息在数据库重开后仍存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-history-'));
  const dbPath = join(dir, 'local.db');
  try {
    run(dbPath, `
      const db = await import('./server/src/db.js');
      await db.query("INSERT INTO projects (id,name) VALUES ($1,$2)", ['p1','workspace']);
      await db.query("INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)", ['s1','p1','history']);
      await db.query("INSERT INTO session_messages (id,session_id,role,content_items,sequence_number) VALUES ($1,$2,$3,$4,$5)", ['m1','s1','user','[{"type":"text","content":"hello"}]',1]);
      db.closeDb();
    `);
    const output = run(dbPath, `
      const db = await import('./server/src/db.js');
      const session = await db.queryOne('SELECT title,message_count FROM sessions WHERE id=$1', ['s1']);
      const messages = await db.query('SELECT role,content_items FROM session_messages WHERE session_id=$1 ORDER BY sequence_number', ['s1']);
      console.log(JSON.stringify({ session, messages }));
      db.closeDb();
    `);
    const restored = JSON.parse(output);
    assert.equal(restored.session.title, 'history');
    assert.equal(restored.messages.length, 1);
    assert.equal(JSON.parse(restored.messages[0].content_items)[0].content, 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
