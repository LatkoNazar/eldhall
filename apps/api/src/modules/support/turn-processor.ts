import { HarnessError, type SupportHarness } from '../agent/harness.js';
import type { SupportStore } from './store.js';

/** Worker ticks share one sweep; a slow sweep cannot overlap the next timer tick.
 * Lifecycle maintenance is independent of Redis and does not need an operator page visit. */
export function createSupportMaintenance(store: Pick<SupportStore, 'recoverInterruptedExecutions'>, clock = Date.now) {
  let nextSweepAt = 0;
  let sweep: Promise<void> | undefined;
  return (): Promise<void> => {
    if (sweep) return sweep;
    if (clock() < nextSweepAt) return Promise.resolve();
    sweep = Promise.resolve().then(() => store.recoverInterruptedExecutions()).finally(() => {
      nextSweepAt = clock() + 10000;
      sweep = undefined;
    });
    return sweep;
  };
}

/** PostgreSQL is authoritative; BullMQ delivery may be repeated or reconstructed. */
export async function publishPendingTurns(store: SupportStore, publish: (id: string) => Promise<void>): Promise<number> {
  const jobs = await store.pendingTurnJobs(50);
  for (const job of jobs) await publish(job.id);
  return jobs.length;
}

export async function processSupportTurn(id: string, workerId: string, store: SupportStore, harness: SupportHarness): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  const claimed = await store.claimTurnJob(id, workerId);
  if (!claimed) return;
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = store.heartbeatTurnJob(claimed.lease).then(() => undefined)
      .catch(() => undefined).finally(() => { heartbeat = undefined; });
  }, 5000);
  try {
    await harness.runQueued(claimed.job, claimed.lease);
  } catch (error) {
    const retry = !(error instanceof HarnessError && error.status === 409);
    await store.failTurnJob(claimed.lease, 'Support runtime did not complete this attempt', retry);
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
    await store.releaseTurn(claimed.lease);
  }
}
