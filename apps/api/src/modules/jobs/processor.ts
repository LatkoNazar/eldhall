import { UnrecoverableError, type Job } from 'bullmq';
import type { JobStore } from './repository.js';
import { executeJob, MissingJob, UnsupportedOperation } from './service.js';
import { JOB_NAME, type JobMessage } from '../../core/queue.js';

export function jobReference(data: unknown): string {
  const id = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).jobId : undefined;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new UnrecoverableError('Invalid job reference');
  return id;
}

export async function processJob(job: Pick<Job<JobMessage>, 'data' | 'name'>, store: JobStore): Promise<string | null> {
  if (job.name !== JOB_NAME) throw new UnrecoverableError('Unsupported task');
  try { return await executeJob(store, jobReference(job.data)); }
  catch (error) {
    if (error instanceof MissingJob || error instanceof UnsupportedOperation) throw new UnrecoverableError(error.message);
    throw error;
  }
}

export async function persistQueueFailure(job: Pick<Job<JobMessage>, 'data' | 'getState'>, store: JobStore): Promise<void> {
  // 'failed' fires per attempt: only persist the framework's terminal state,
  // including exhausted stalled recovery. SQL atomically preserves success.
  if (await job.getState() === 'failed') await store.failed(jobReference(job.data), 'Background job failed after retries');
}
