import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('模型详情不返回明文 API key，提交掩码时保留原密钥', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-model-secret-'));
  process.env.PI_DB_PATH = join(home, 'local.db');
  const db = await import('../src/db.js');
  const models = await import('../src/app/models/index.js');
  const ctx = { query: db.query, queryOne: db.queryOne };

  t.after(() => {
    db.closeDb();
    rmSync(home, { recursive: true, force: true });
  });

  const created = await models.createModel(ctx, {
    body: {
      model_name: 'example-model',
      api_base: 'https://example.invalid/v1',
      api_key: 'real-secret-key',
    },
  });
  assert.equal(created.api_key, '********');

  const updated = await models.updateModel(ctx, {
    body: {
      id: created.id,
      model_name: 'example-model-v2',
      api_base: 'https://example.invalid/v1',
      api_key: '********',
    },
  });
  assert.equal(updated.api_key, '********');

  const stored = await db.queryOne('SELECT api_key FROM llm_models WHERE id=$1', [created.id]);
  assert.equal(stored.api_key, 'real-secret-key');
});
