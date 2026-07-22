import test from 'node:test';
import assert from 'node:assert/strict';

import { sqlite } from '../../db.js';
import { createBackgroundJob, getBackgroundJob } from '../jobs/background_jobs.js';
import { collectEnrichmentErrors, runConnectionEnrichmentJob } from './enrichment_job_service.js';

test('collectEnrichmentErrors reports skipped and failed offline preparation steps', () => {
  assert.deepEqual(
    collectEnrichmentErrors({
      example: { updated: 3 },
      columns: { error: '模型超时' },
      schema_file: { error: '磁盘写入失败' },
    }),
    ['columns: 模型超时', 'schema_file: 磁盘写入失败'],
  );
  assert.deepEqual(collectEnrichmentErrors({ skipped: '连接不存在' }), ['连接不存在']);
});

test('offline preparation job cannot complete when an internal step failed', async () => {
  const job = createBackgroundJob({
    projectId: 'offline-test-project',
    kind: 'structured_connection_enrichment',
    resourceType: 'database_connection',
    resourceId: 'offline-test-connection',
  });
  try {
    const result = await runConnectionEnrichmentJob(job, {
      enrich: async () => ({
        example: { updated: 2 },
        columns: { error: '模型超时' },
        schema_file: { path: '/tmp/schema.sql' },
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'enrichment_incomplete');
    assert.match(result.error_message, /columns: 模型超时/);
    assert.equal(getBackgroundJob(job.id).attempt_count, 1);
  } finally {
    sqlite.prepare('DELETE FROM background_jobs WHERE id=?').run(job.id);
  }
});

test('offline preparation job completes only when every required step succeeds', async () => {
  const job = createBackgroundJob({
    projectId: 'offline-test-project',
    kind: 'database_schema_enrichment',
    resourceType: 'database_connection',
    resourceId: 'offline-test-connection-ready',
  });
  try {
    const result = await runConnectionEnrichmentJob(job, {
      enrich: async () => ({
        example: { updated: 2 },
        distinct: { updated: 2 },
        schema_file: { path: '/tmp/schema.sql' },
      }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.progress, 100);
    assert.equal(result.error_message, null);
  } finally {
    sqlite.prepare('DELETE FROM background_jobs WHERE id=?').run(job.id);
  }
});
