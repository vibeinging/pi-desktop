import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('database eval import keeps offline preparation deterministic and vector-free', () => {
  const src = readFileSync('eval/lib/driver.mjs', 'utf8');
  const importStart = src.indexOf('async importDatabase(');
  const importEnd = src.indexOf('async importUnstructured(', importStart);
  const importDatabase = src.slice(importStart, importEnd);

  assert.ok(importStart >= 0 && importEnd > importStart);
  assert.match(importDatabase, /sync-schema/);
  assert.match(importDatabase, /batch_sync_example_values/);
  assert.doesNotMatch(importDatabase, /generate-columns-descriptions/);
  assert.doesNotMatch(importDatabase, /store-vectors/);
  assert.doesNotMatch(src, /tables\/store-vectors/);
});
