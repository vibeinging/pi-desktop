import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('旧模型和 MCP 明文密钥迁移为系统凭据引用', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-credential-migration-'));
  process.env.PI_DB_PATH = join(home, 'local.db');
  const db = await import('../src/db.js');
  const credentials = await import('../src/credentials.js');
  const secrets = new Map();
  credentials.setCredentialProvider({
    get: async (ref) => secrets.get(ref) ?? null,
    set: async (ref, value) => { secrets.set(ref, value); return true; },
    delete: async (ref) => secrets.delete(ref),
  });

  t.after(() => {
    credentials.setCredentialProvider(null);
    db.closeDb();
    rmSync(home, { recursive: true, force: true });
  });

  await db.query('INSERT INTO llm_models (id,model_name,api_base,api_key) VALUES ($1,$2,$3,$4)', ['m1','model','https://example.test','model-secret']);
  await db.query(
    `INSERT INTO app_mcp_providers (id,provider_name,transport,command,env)
     VALUES ($1,$2,$3,$4,$5)`,
    ['mp1','provider','stdio','node',JSON.stringify({ API_TOKEN: 'mcp-secret', EMPTY: '' })],
  );
  const result = await credentials.migrateLegacyCredentials({ query: db.query });
  assert.equal(result.status, 'complete');
  assert.equal(result.migrated, 2);

  const model = await db.queryOne('SELECT api_key FROM llm_models WHERE id=$1', ['m1']);
  const provider = await db.queryOne('SELECT env FROM app_mcp_providers WHERE id=$1', ['mp1']);
  const env = JSON.parse(provider.env);
  assert.match(model.api_key, /^credential:model:/);
  assert.match(env.API_TOKEN, /^credential:mcp:/);
  assert.equal(env.EMPTY, '');
  assert.equal(await credentials.resolveCredential(model.api_key), 'model-secret');
  assert.deepEqual(await credentials.resolveCredentialMap(env), { API_TOKEN: 'mcp-secret', EMPTY: '' });
});

test('系统凭据写入失败时保留 SQLite 旧明文并报告状态', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-credential-failure-'));
  process.env.PI_DB_PATH = join(home, 'local.db');
  const dbUrl = new URL('../src/db.js?credential-failure', import.meta.url);
  const db = await import(dbUrl.href);
  const credentials = await import('../src/credentials.js');
  credentials.setCredentialProvider({
    get: async () => null,
    set: async () => { throw new Error('keychain locked'); },
    delete: async () => false,
  });
  t.after(() => {
    credentials.setCredentialProvider(null);
    db.closeDb();
    rmSync(home, { recursive: true, force: true });
  });
  await db.query('INSERT INTO llm_models (id,model_name,api_base,api_key) VALUES ($1,$2,$3,$4)', ['m2','model','https://example.test','keep-me']);
  const result = await credentials.migrateLegacyCredentials({ query: db.query });
  assert.equal(result.status, 'partial');
  assert.match(result.errors[0], /keychain locked/);
  const model = await db.queryOne('SELECT api_key FROM llm_models WHERE id=$1', ['m2']);
  assert.equal(model.api_key, 'keep-me');
});
