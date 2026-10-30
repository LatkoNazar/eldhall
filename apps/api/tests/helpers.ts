import { randomUUID } from 'node:crypto';
import type { JobStore } from '../src/modules/jobs/repository.js';
import type { Job, JobCreate } from '../src/modules/jobs/schema.js';

export class MemoryStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  async create(payload: JobCreate): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), text: payload.text, operation: payload.operation ?? 'uppercase', status: 'queued', result: null, error: null, created_at: now, updated_at: now };
    this.jobs.set(job.id, job);
    return { ...job };
  }
  async find(id: string): Promise<Job | null> { const job = this.jobs.get(id); return job ? { ...job } : null; }
  async running(id: string): Promise<void> { if (this.jobs.get(id)?.status !== 'succeeded') Object.assign(this.jobs.get(id)!, { status: 'running', error: null }); }
  async succeeded(id: string, result: string): Promise<void> { Object.assign(this.jobs.get(id)!, { status: 'succeeded', result, error: null }); }
  async failed(id: string, error: string): Promise<void> { if (this.jobs.get(id)?.status !== 'succeeded') Object.assign(this.jobs.get(id)!, { status: 'failed', error }); }
}
