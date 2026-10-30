import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Job, JobCreate } from './schema.js';

export interface JobStore {
  create(payload: JobCreate): Promise<Job>;
  find(id: string): Promise<Job | null>;
  running(id: string): Promise<void>;
  succeeded(id: string, result: string): Promise<void>;
  failed(id: string, error: string): Promise<void>;
}

interface JobRow extends Omit<Job, 'created_at' | 'updated_at'> { created_at: Date; updated_at: Date }
function serialize(row: JobRow): Job {
  return { ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

export class PostgresJobStore implements JobStore {
  constructor(readonly pool: pg.Pool) {}

  async create(payload: JobCreate): Promise<Job> {
    const now = new Date();
    const result = await this.pool.query<JobRow>(
      `INSERT INTO jobs(id,text,operation,status,result,error,created_at,updated_at)
       VALUES($1,$2,$3,'queued',NULL,NULL,$4,$4) RETURNING *`,
      [randomUUID(), payload.text, payload.operation ?? 'uppercase', now],
    );
    return serialize(result.rows[0]!);
  }

  async find(id: string): Promise<Job | null> {
    const result = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE id=$1', [id]);
    return result.rows[0] ? serialize(result.rows[0]) : null;
  }

  async running(id: string): Promise<void> {
    await this.pool.query("UPDATE jobs SET status='running', error=NULL, updated_at=$2 WHERE id=$1 AND status<>'succeeded'", [id, new Date()]);
  }
  async succeeded(id: string, result: string): Promise<void> {
    await this.pool.query("UPDATE jobs SET status='succeeded', result=$2, error=NULL, updated_at=$3 WHERE id=$1", [id, result, new Date()]);
  }
  async failed(id: string, error: string): Promise<void> {
    await this.pool.query("UPDATE jobs SET status='failed', error=$2, updated_at=$3 WHERE id=$1 AND status<>'succeeded'", [id, error, new Date()]);
  }
}
