import type { JobStore } from './repository.js';
import type { Job, JobCreate } from './schema.js';

export class QueueUnavailable extends Error {}
export class MissingJob extends Error {}
export class UnsupportedOperation extends Error {}

export function transform(text: string, operation: string): string {
  if (operation === 'uppercase') return text.toUpperCase();
  if (operation === 'reverse') return Array.from(text).reverse().join('');
  throw new UnsupportedOperation('Unsupported operation');
}

export async function createJob(store: JobStore, payload: JobCreate, dispatch: (id: string) => Promise<void>): Promise<Job> {
  const job = await store.create(payload);
  try { await dispatch(job.id); }
  catch {
    await store.failed(job.id, 'Queue unavailable; submit a new job when service recovers');
    throw new QueueUnavailable('Queue unavailable; please retry later');
  }
  return job;
}

export async function executeJob(store: JobStore, jobId: string): Promise<string | null> {
  const job = await store.find(jobId);
  if (!job) throw new MissingJob('Job does not exist');
  if (job.status === 'succeeded') return job.result;
  await store.running(jobId);
  let result: string;
  try { result = transform(job.text, job.operation); }
  catch (error) {
    if (error instanceof UnsupportedOperation) await store.failed(jobId, 'Unsupported operation');
    throw error;
  }
  await store.succeeded(jobId, result);
  return result;
}

export async function readJob(store: JobStore, jobId: string, queueFailed: (id: string) => Promise<boolean>): Promise<Job | null> {
  const job = await store.find(jobId);
  if (!job || job.status === 'succeeded' || job.status === 'failed') return job;
  // Recover a missed terminal SQL update after PG downtime from retained BullMQ
  // state; PostgreSQL results remain readable while Redis is unavailable.
  let failed: boolean;
  try { failed = await queueFailed(jobId); } catch { return job; }
  if (failed) {
    await store.failed(jobId, 'Background job failed after retries');
    return store.find(jobId);
  }
  return job;
}
