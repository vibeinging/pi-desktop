import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

function run(dir, source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      PI_DB_PATH: join(dir, 'local.db'),
    },
    encoding: 'utf8',
  });
}

test('SQLite transcript 原子追加、重写失败回滚并可导出恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-transcript-'));
  try {
    const result = run(dir, `
      const db = await import('./server/src/db.js');
      const { exportTranscriptJsonl } = await import('./server/src/engine/agents/sessionStore.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      db.appendAgentTranscript({ sessionId: 's1', messages: [{ role: 'user', content: 'one' }] });
      let appendError = '';
      try {
        db.appendAgentTranscript({
          sessionId: 's1',
          messages: [{ role: 'assistant', content: 'must rollback' }, { value: 1n }],
        });
      } catch (error) { appendError = error.message; }
      let replaceError = '';
      try {
        db.replaceAgentTranscript({ sessionId: 's1', messages: [{ role: 'user', content: 'new' }, { value: 1n }] });
      } catch (error) { replaceError = error.message; }
      const transcript = db.loadAgentTranscript('s1');
      const rows = await db.query(
        'SELECT sequence_number FROM agent_transcript_messages WHERE session_id=$1 ORDER BY sequence_number',
        ['s1'],
      );
      const exported = await exportTranscriptJsonl(db, 's1');
      console.log(JSON.stringify({ appendError, replaceError, transcript, sequences: rows.map((row) => row.sequence_number), exported }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.match(output.appendError, /BigInt/);
    assert.match(output.replaceError, /BigInt/);
    assert.deepEqual(output.transcript, [{ role: 'user', content: 'one' }]);
    assert.deepEqual(output.sequences, [1]);
    const lines = output.exported.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { type: 'session', version: 1, id: 's1' });
    assert.deepEqual(lines[1], { type: 'message', message: { role: 'user', content: 'one' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent 投影落后于界面历史时会从权威历史重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-transcript-repair-'));
  try {
    const result = run(dir, `
      const db = await import('./server/src/db.js');
      const { ensureTranscriptProjection } = await import('./server/src/engine/agents/sessionStore.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      db.appendSessionMessage({
        id: 'ui-1', sessionId: 's1', role: 'user', contentItems: '[{"type":"text","content":"old"}]', metadata: '{}'
      });
      db.appendSessionMessage({
        id: 'ui-2', sessionId: 's1', role: 'assistant', contentItems: '[{"type":"text","content":"answer"}]', metadata: '{}'
      });
      db.replaceAgentTranscriptProjection({
        sessionId: 's1', sourceSequenceNumber: 2,
        messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }]
      });
      db.appendSessionMessage({
        id: 'ui-3', sessionId: 's1', role: 'user', contentItems: '[{"type":"text","content":"visible after crash"}]', metadata: '{}'
      });
      const repaired = await ensureTranscriptProjection(db, 's1', {
        sourceSequenceNumber: 3,
        fallbackMessages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
          { role: 'user', content: 'visible after crash' }
        ]
      });
      console.log(JSON.stringify({ repaired, state: db.getAgentTranscriptState('s1') }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.repaired.at(-1).content, 'visible after crash');
    assert.equal(output.state.source_sequence_number, 3);
    assert.ok(output.state.revision >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话锁让压缩重写和新消息追加按顺序执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-transcript-lock-'));
  try {
    const result = run(dir, `
      const db = await import('./server/src/db.js');
      const { makeCtx } = await import('./server/src/ctx.js');
      const { appendMessage } = await import('./server/src/app/session/index.js');
      const { withSessionLock } = await import('./server/src/engine/agents/sessionStore.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      db.replaceAgentTranscript({ sessionId: 's1', messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })) });
      let releaseCompact;
      const compactCanFinish = new Promise((resolve) => { releaseCompact = resolve; });
      let compactLoaded;
      const compact = withSessionLock('s1', async () => {
        compactLoaded = db.loadAgentTranscript('s1');
        await compactCanFinish;
        db.replaceAgentTranscript({ sessionId: 's1', messages: compactLoaded.slice(-4) });
      });
      await new Promise((resolve) => setImmediate(resolve));
      const append = withSessionLock('s1', async () => {
        db.appendAgentTranscript({ sessionId: 's1', messages: [{ role: 'user', content: 'arrived during compact' }] });
      });
      let directAppendResolved = false;
      const directAppend = appendMessage(makeCtx(), {
        params: { pid: 'p1', sid: 's1' },
        body: { role: 'user', content: 'visible message queued during compact' },
      }).then(() => { directAppendResolved = true; });
      await new Promise((resolve) => setImmediate(resolve));
      const directAppendResolvedBeforeRelease = directAppendResolved;
      releaseCompact();
      await Promise.all([compact, append, directAppend]);
      const transcript = db.loadAgentTranscript('s1');
      const visibleMessages = await db.query(
        'SELECT content_items FROM session_messages WHERE session_id=$1 ORDER BY sequence_number',
        ['s1'],
      );
      console.log(JSON.stringify({ transcript, visibleMessages, directAppendResolvedBeforeRelease }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.directAppendResolvedBeforeRelease, false);
    assert.equal(output.transcript.at(-1).content, 'arrived during compact');
    assert.equal(output.transcript.length, 5);
    assert.match(output.visibleMessages[0].content_items, /visible message queued during compact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧 JSONL 只导入一次，会话删除同时清理 SQLite 和旧文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-legacy-transcript-'));
  try {
    const result = run(dir, `
      const { existsSync, mkdirSync, readdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const db = await import('./server/src/db.js');
      const { makeCtx } = await import('./server/src/ctx.js');
      const { deleteSession } = await import('./server/src/app/session/index.js');
      const { loadTranscript } = await import('./server/src/engine/agents/sessionStore.js');
      await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1','workspace']);
      await db.query('INSERT INTO sessions (id,project_id,title) VALUES ($1,$2,$3)', ['s1','p1','chat']);
      db.appendSessionMessage({
        id: 'ui-1', sessionId: 's1', role: 'user', contentItems: '[{"type":"text","content":"delete me"}]', metadata: '{}'
      });
      await db.query(
        'INSERT INTO agent_runs (id,session_id,project_id,status) VALUES ($1,$2,$3,$4)',
        ['run-1','s1','p1','running']
      );
      await db.query(
        'INSERT INTO agent_pending_inputs (id,run_id,session_id,project_id,request_id,input_type,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['pending-1','run-1','s1','p1','request-1','approval','pending']
      );
      const legacyDir = join(process.env.HOME, '.pi-desktop', 'agent-sessions');
      const legacyPath = join(legacyDir, 's1.jsonl');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(legacyPath, [
        JSON.stringify({ type: 'session', version: 1, id: 's1' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'legacy' } }),
        '{broken',
        '',
      ].join('\\n'));
      const first = await loadTranscript(db, 's1');
      const second = await loadTranscript(db, 's1');
      const filesAfterImport = readdirSync(legacyDir);
      writeFileSync(legacyPath, JSON.stringify({ type: 'session', version: 1, id: 's1' }) + '\\n');
      await deleteSession(makeCtx(), { params: { pid: 'p1', sid: 's1' } });
      const session = await db.queryOne('SELECT deleted_at,message_count FROM sessions WHERE id=$1', ['s1']);
      const rows = await db.query('SELECT * FROM agent_transcript_messages WHERE session_id=$1', ['s1']);
      const uiRows = await db.query('SELECT * FROM session_messages WHERE session_id=$1', ['s1']);
      const runs = await db.query('SELECT * FROM agent_runs WHERE session_id=$1', ['s1']);
      const pending = await db.query('SELECT * FROM agent_pending_inputs WHERE session_id=$1', ['s1']);
      const remainingFiles = existsSync(legacyDir) ? readdirSync(legacyDir) : [];
      console.log(JSON.stringify({
        first, second, filesAfterImport, deleted: Boolean(session.deleted_at),
        rowCount: rows.length, uiCount: uiRows.length, runCount: runs.length,
        pendingCount: pending.length, messageCount: session.message_count, remainingFiles
      }));
      db.closeDb();
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(output.first, [{ role: 'user', content: 'legacy' }]);
    assert.deepEqual(output.second, output.first);
    assert.deepEqual(output.filesAfterImport, ['s1.jsonl.migrated']);
    assert.equal(output.deleted, true);
    assert.equal(output.rowCount, 0);
    assert.equal(output.uiCount, 0);
    assert.equal(output.runCount, 0);
    assert.equal(output.pendingCount, 0);
    assert.equal(output.messageCount, 0);
    assert.deepEqual(output.remainingFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
