import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('MCP API 不返回明文环境变量，提交掩码时保留原值', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-mcp-secret-'));
  process.env.PI_DB_PATH = join(home, 'local.db');
  const db = await import('../src/db.js');
  const mcp = await import('../src/app/integrations/mcp.js');
  const ctx = { query: db.query, queryOne: db.queryOne };

  t.after(() => {
    db.closeDb();
    rmSync(home, { recursive: true, force: true });
  });

  const created = await mcp.createAppMcpProvider(ctx, {
    body: {
      provider_name: 'secret-provider',
      command: 'node',
      env: { API_TOKEN: 'real-token', EMPTY_VALUE: '' },
    },
  });
  assert.deepEqual(created.data.env, { API_TOKEN: '********', EMPTY_VALUE: '' });

  const updated = await mcp.updateAppMcpProvider(ctx, {
    params: { providerName: 'secret-provider' },
    body: { env: { API_TOKEN: '********', EMPTY_VALUE: '', NEW_VALUE: 'next-token' } },
  });
  assert.deepEqual(updated.data.env, {
    API_TOKEN: '********',
    EMPTY_VALUE: '',
    NEW_VALUE: '********',
  });

  const stored = await db.queryOne('SELECT env FROM app_mcp_providers WHERE provider_name=$1', ['secret-provider']);
  assert.deepEqual(JSON.parse(stored.env), {
    API_TOKEN: 'real-token',
    EMPTY_VALUE: '',
    NEW_VALUE: 'next-token',
  });
});
