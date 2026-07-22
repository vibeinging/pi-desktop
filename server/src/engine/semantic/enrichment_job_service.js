import {
  getBackgroundJob,
  listIncompleteBackgroundJobs,
  updateBackgroundJob,
} from '../jobs/background_jobs.js';
import { enrichConnection } from './enrich.js';

const ACTIVE = new Set();
const JOB_KINDS = new Set(['structured_connection_enrichment', 'database_schema_enrichment']);

export function collectEnrichmentErrors(result = {}) {
  const errors = [];
  if (result?.skipped) errors.push(String(result.skipped));
  for (const [step, value] of Object.entries(result || {})) {
    if (value && typeof value === 'object' && value.error) {
      errors.push(`${step}: ${String(value.error)}`);
    }
  }
  return errors;
}

export async function runConnectionEnrichmentJob(jobOrId, { enrich = enrichConnection } = {}) {
  const job = typeof jobOrId === 'string' ? getBackgroundJob(jobOrId) : jobOrId;
  if (!job || !JOB_KINDS.has(job.kind)) return null;
  if (ACTIVE.has(job.id)) return getBackgroundJob(job.id);
  if (job.attempt_count >= job.max_attempts) {
    return updateBackgroundJob(job.id, {
      status: 'failed',
      error_code: 'enrichment_attempts_exhausted',
      error_message: `离线数据准备达到最大尝试次数(${job.max_attempts})`,
      finished_at: new Date().toISOString(),
      next_retry_at: null,
    });
  }

  ACTIVE.add(job.id);
  updateBackgroundJob(job.id, {
    status: 'running',
    progress: 5,
    error_code: null,
    error_message: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    next_retry_at: null,
    incrementAttempt: true,
  });
  try {
    const result = await enrich(job.resource_id, {
      projectId: job.project_id,
      descriptions: job.kind === 'structured_connection_enrichment',
    });
    const errors = collectEnrichmentErrors(result);
    if (errors.length) {
      return updateBackgroundJob(job.id, {
        status: 'failed',
        progress: 100,
        error_code: 'enrichment_incomplete',
        error_message: errors.join('；').slice(0, 2000),
        result_json: result,
        finished_at: new Date().toISOString(),
      });
    }
    return updateBackgroundJob(job.id, {
      status: 'completed',
      progress: 100,
      error_code: null,
      error_message: null,
      result_json: result || { connection_id: job.resource_id },
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    return updateBackgroundJob(job.id, {
      status: 'failed',
      error_code: 'enrichment_failed',
      error_message: String(error?.message || error),
      finished_at: new Date().toISOString(),
    });
  } finally {
    ACTIVE.delete(job.id);
  }
}

export function enqueueConnectionEnrichmentJob(job) {
  queueMicrotask(() => {
    runConnectionEnrichmentJob(job)
      .catch((error) => console.warn(`[offline preparation] 任务 ${job?.id || '?'} 失败:`, error?.message || error));
  });
  return job;
}

export async function resumeConnectionEnrichmentJobs() {
  const jobs = [
    ...listIncompleteBackgroundJobs('structured_connection_enrichment'),
    ...listIncompleteBackgroundJobs('database_schema_enrichment'),
  ];
  for (const job of jobs) enqueueConnectionEnrichmentJob(job);
  if (jobs.length) console.info(`[offline preparation] 已续跑 ${jobs.length} 个结构化数据准备任务`);
  return jobs.length;
}

export default runConnectionEnrichmentJob;
