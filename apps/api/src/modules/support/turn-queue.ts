import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Queue, Worker, createNodeRedisClient } from 'bullmq';
import type { Settings } from '../../core/config.js';
import { createWorkerRedis } from '../../core/queue.js';
import { useCache } from '../../core/cache.js';
import type { SupportDependencies } from './routes.js';
import { createSupportMaintenance, processSupportTurn, publishPendingTurns } from './turn-processor.js';

export interface SupportQueueMessage { runId: string }
export const supportQueueName = (settings: Settings) => settings.bullmqQueue + '-support-turns';

export async function startSupportWorker(settings: Settings, support: SupportDependencies) {
  const workerRedis = createWorkerRedis(settings);
  const workerId = hostname() + ':' + randomUUID();
  const worker = new Worker<SupportQueueMessage>(supportQueueName(settings), job =>
    processSupportTurn(job.data.runId, workerId, support.store, support.harness), {
    connection: createNodeRedisClient(workerRedis),
    prefix: settings.bullmqPrefix,
    concurrency: settings.workerConcurrency,
    autorun: false,
    lockDuration: 30000,
    stalledInterval: 15000,
    maxStalledCount: 3,
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 0 },
  });
  let closing = false;
  let relay: Promise<void> | undefined;
  const maintain = createSupportMaintenance(support.store);
  const publish = () => {
    if (closing || relay) return relay;
    // Sweep expiry/recovery before opening a Redis connection: a broker outage
    // must not leave approvals or interrupted effects waiting for an operator visit.
    relay = maintain().then(() => useCache(settings, settings.bullmqDb, async redis => {
      const queue = new Queue<SupportQueueMessage>(supportQueueName(settings), {
        connection: createNodeRedisClient(redis), prefix: settings.bullmqPrefix, skipWaitingForReady: true,
        defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
        streams: { events: { maxLen: 1000 } },
      });
      queue.on('error', () => console.warn('Support queue publisher unavailable'));
      try { await publishPendingTurns(support.store, async id => { await queue.add('support-turn', { runId: id }, { jobId: id }); }); }
      finally { await queue.close(); }
    })).then(() => undefined)
      .catch(() => { console.warn('Support outbox publish unavailable; persisted turns will be retried'); })
      .finally(() => { relay = undefined; });
    return relay;
  };
  const timer = setInterval(() => { void publish(); }, 2000);
  worker.on('error', () => console.warn('Support worker unavailable; waiting for recovery'));
  worker.on('failed', () => console.warn('Support run attempt failed; PostgreSQL retains its outcome'));
  void worker.run().catch(() => console.warn('Support worker processing stopped'));
  await worker.waitUntilReady();
  await publish();
  return {
    isRunning: () => worker.isRunning() && workerRedis.isReady,
    async close() {
      closing = true;
      clearInterval(timer);
      await relay;
      await worker.close();
      if (workerRedis.isOpen) workerRedis.destroy();
    },
  };
}
