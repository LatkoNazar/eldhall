import { reopenTrackedCaseForMessage } from './requests/postgres.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AcceptedTurn, Message, SupportCase, SupportTurnJob, TurnLease } from './contracts.js';
import { VersionConflict } from './store.js';

const row = <T>(value: Record<string, unknown>): T => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !['active_run_id', 'active_run_at'].includes(key))
  .map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), item instanceof Date ? item.toISOString() : item])) as T;
const caseQuery = 'SELECT c.*,u.name AS customer_name FROM support_cases c JOIN support_customers u ON u.id=c.customer_id WHERE c.id=$1';

export class PostgresTurnJobs {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(caseId: string, customerId: string, body: string, clientMessageId?: string): Promise<AcceptedTurn> {
    return this.transaction(async client => {
      const cases = await client.query(caseQuery + ' FOR UPDATE OF c', [caseId]);
      const supportCase = cases.rows[0] ? row<SupportCase>(cases.rows[0]) : null;
      if (!supportCase || supportCase.customerId !== customerId) throw new VersionConflict('Conversation not found');
      if (clientMessageId) {
        const existing = await client.query('SELECT * FROM support_messages WHERE case_id=$1 AND client_message_id=$2', [caseId, clientMessageId]);
        if (existing.rows[0]) {
          const message = row<Message>(existing.rows[0]);
          if (message.body !== body) throw new VersionConflict('Message id already identifies different content');
          const jobs = await client.query('SELECT * FROM support_turn_jobs WHERE customer_message_id=$1', [message.id]);
          return { case: supportCase, message, job: jobs.rows[0] ? row<SupportTurnJob>(jobs.rows[0]) : null };
        }
      }
      const pending = await client.query("SELECT * FROM support_turn_jobs WHERE case_id=$1 AND status IN ('queued','running')", [caseId]);
      if (pending.rows[0]) {
        const job = row<SupportTurnJob>(pending.rows[0]);
        if (job.body !== body) throw new VersionConflict('A support run is already queued for this conversation');
        const messages = await client.query('SELECT * FROM support_messages WHERE id=$1', [job.customerMessageId]);
        return { case: supportCase, message: row<Message>(messages.rows[0]), job };
      }
      if (cases.rows[0].active_run_id) throw new VersionConflict('A support run is active');
      const messages = await client.query("INSERT INTO support_messages(id,case_id,role,body,client_message_id) VALUES($1,$2,'customer',$3,$4) RETURNING *", [randomUUID(), caseId, body, clientMessageId ?? null]);
      const message = row<Message>(messages.rows[0]);
      await reopenTrackedCaseForMessage(client,caseId,body);
      const refreshed=(await client.query('SELECT status FROM support_cases WHERE id=$1',[caseId])).rows[0];supportCase.status=refreshed.status;
      await client.query('UPDATE support_cases SET updated_at=now() WHERE id=$1', [caseId]);
      if (supportCase.ownership === 'staff') {
        await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'message.routed_to_staff',$3,'{}')", [randomUUID(), caseId, 'customer:' + customerId]);
        return { case: supportCase, message, job: null };
      }
      const jobs = await client.query("INSERT INTO support_turn_jobs(id,case_id,customer_id,customer_message_id,body,ownership_version,status) VALUES($1,$2,$3,$4,$5,$6,'queued') RETURNING *", [randomUUID(), caseId, customerId, message.id, body, supportCase.ownershipVersion]);
      const job = row<SupportTurnJob>(jobs.rows[0]);
      await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'message.accepted',$3,$4)", [randomUUID(), caseId, 'customer:' + customerId, JSON.stringify({ runId: job.id, length: body.length })]);
      return { case: supportCase, message, job };
    });
  }

  async pending(limit = 50): Promise<SupportTurnJob[]> {
    const result = await this.pool.query("SELECT * FROM support_turn_jobs WHERE (status='queued' AND available_at<=now()) OR (status='running' AND lease_expires_at<=now()) ORDER BY created_at LIMIT $1", [limit]);
    return result.rows.map(value => row<SupportTurnJob>(value));
  }

  async active(caseId: string): Promise<SupportTurnJob | null> {
    const result = await this.pool.query("SELECT * FROM support_turn_jobs WHERE case_id=$1 AND status IN ('queued','running')", [caseId]);
    return result.rows[0] ? row<SupportTurnJob>(result.rows[0]) : null;
  }

  async claim(id: string, workerId: string): Promise<{ job: SupportTurnJob; lease: TurnLease } | null> {
    return this.transaction(async client => {
      const found = await client.query('SELECT case_id FROM support_turn_jobs WHERE id=$1', [id]);
      if (!found.rows[0]) return null;
      const cases = await client.query('SELECT * FROM support_cases WHERE id=$1 FOR UPDATE', [found.rows[0].case_id]);
      const eligible = await client.query("SELECT * FROM support_turn_jobs WHERE id=$1 AND available_at<=now() AND (status='queued' OR (status='running' AND lease_expires_at<=now())) FOR UPDATE", [id]);
      if (!eligible.rows[0]) return null;
      const supportCase = cases.rows[0];
      const job = row<SupportTurnJob>(eligible.rows[0]);
      if (supportCase.ownership !== 'bot' || supportCase.ownership_version !== job.ownershipVersion) {
        await client.query("UPDATE support_turn_jobs SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [id]);
        return null;
      }
      if (job.attempts >= 3) {
        await client.query("UPDATE support_turn_jobs SET status='failed',worker_id=NULL,lease_expires_at=NULL,error='Worker recovery limit reached',updated_at=now() WHERE id=$1", [id]);
        await client.query('UPDATE support_cases SET active_run_id=NULL,active_run_at=NULL WHERE id=$1 AND active_run_id=$2', [job.caseId,id]);
        await client.query("INSERT INTO support_messages(id,case_id,role,body) VALUES($1,$2,'system',$3)", [randomUUID(),job.caseId,'Не вдалося завершити відповідь після відновлення. Зверніться до оператора.']);
        await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'run.failed','worker:recovery',$3)", [randomUUID(),job.caseId,JSON.stringify({runId:id,attempts:job.attempts})]);
        return null;
      }
      if (supportCase.active_run_id && supportCase.active_run_id !== id) return null;
      const claimed = await client.query("UPDATE support_turn_jobs SET status='running',attempts=attempts+1,fence=fence+1,worker_id=$2,lease_expires_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 RETURNING *", [id, workerId]);
      const running = row<SupportTurnJob>(claimed.rows[0]);
      await client.query('UPDATE support_cases SET active_run_id=$2,active_run_at=now() WHERE id=$1', [job.caseId, id]);
      return { job: running, lease: { caseId: job.caseId, runId: id, ownershipVersion: job.ownershipVersion, jobFence: running.fence, workerId } };
    });
  }

  async heartbeat(lease: TurnLease): Promise<boolean> {
    return this.transaction(async client => {
      const cases = await client.query("SELECT id FROM support_cases WHERE id=$1 AND ownership='bot' AND ownership_version=$2 AND active_run_id=$3 FOR UPDATE", [lease.caseId, lease.ownershipVersion, lease.runId]);
      if (!cases.rowCount) return false;
      const result = await client.query("UPDATE support_turn_jobs SET lease_expires_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND fence=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now() RETURNING case_id", [lease.runId, lease.jobFence, lease.workerId]);
      if (!result.rowCount) return false;
      await client.query('UPDATE support_cases SET active_run_at=now() WHERE id=$1 AND active_run_id=$2', [lease.caseId, lease.runId]);
      return true;
    });
  }

  async fail(lease: TurnLease, error: string, retry: boolean): Promise<void> {
    await this.transaction(async client => {
      const cases = await client.query('SELECT ownership,ownership_version FROM support_cases WHERE id=$1 FOR UPDATE', [lease.caseId]);
      const jobs = await client.query("SELECT * FROM support_turn_jobs WHERE id=$1 AND fence=$2 AND worker_id=$3 AND status='running' FOR UPDATE", [lease.runId, lease.jobFence, lease.workerId]);
      if (!jobs.rows[0]) return;
      const owned = cases.rows[0]?.ownership === 'bot' && cases.rows[0].ownership_version === lease.ownershipVersion;
      const status = !owned ? 'cancelled' : retry && jobs.rows[0].attempts < 3 ? 'queued' : 'failed';
      await client.query("UPDATE support_turn_jobs SET status=$2,error=$3,worker_id=NULL,lease_expires_at=NULL,available_at=now()+interval '1 second',updated_at=now() WHERE id=$1", [lease.runId, status, error.slice(0,300)]);
      await client.query('UPDATE support_cases SET active_run_id=NULL,active_run_at=NULL WHERE id=$1 AND active_run_id=$2', [lease.caseId, lease.runId]);
      if (status === 'failed') await client.query("INSERT INTO support_messages(id,case_id,role,body) VALUES($1,$2,'system',$3)", [randomUUID(), lease.caseId, 'Не вдалося завершити відповідь. Зверніться до оператора або надішліть повідомлення ще раз.']);
      await client.query('INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,$3,$4,$5)', [randomUUID(), lease.caseId, 'run.' + status, 'worker', JSON.stringify({ runId: lease.runId, attempts: jobs.rows[0].attempts })]);
    });
  }
}
