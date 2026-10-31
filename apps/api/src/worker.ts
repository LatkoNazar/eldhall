import { hostname } from 'node:os';
import { createNodeRedisClient, Worker } from 'bullmq';
import { getSettings } from './core/config.js';
import { createPool } from './core/database.js';
import { createWorkerRedis, jobOptions, workerHeartbeatKey, type JobMessage } from './core/queue.js';
import { PostgresJobStore } from './modules/jobs/repository.js';
import { persistQueueFailure, processJob } from './modules/jobs/processor.js';

async function main() {
  const settings = getSettings();
  const pool = createPool(settings);
  const store = new PostgresJobStore(pool);
  const redis = createWorkerRedis(settings);
  const options = jobOptions(settings);
  const worker = new Worker<JobMessage, string | null>(settings.bullmqQueue, job => processJob(job, store), {
    connection: createNodeRedisClient(redis), prefix: settings.bullmqPrefix,
    concurrency: settings.workerConcurrency, autorun: false,
    removeOnComplete: options.removeOnComplete,
    removeOnFail: options.removeOnFail,
  });
  const key = workerHeartbeatKey(settings, hostname());
  let closing = false;
  let heartbeatRunning = false;
  const timer = setInterval(() => void heartbeat(), 10000);
  const finalizers = new Set<Promise<void>>();
  worker.on('error', () => console.warn('BullMQ worker unavailable; waiting for recovery'));
  worker.on('failed', job => {
    if (!job) return;
    const finalizer = persistQueueFailure(job, store)
      .catch(() => console.warn('SQL failure state unavailable; a later job read will reconcile retained queue state'))
      .finally(() => finalizers.delete(finalizer));
    finalizers.add(finalizer);
  });
  worker.on('stalled', id => console.warn(`BullMQ recovered stalled job ${id}`));

  async function heartbeat() {
    if (closing || heartbeatRunning || !redis.isReady || !worker.isRunning()) return;
    heartbeatRunning = true;
    try {
      await pool.query('SELECT 1');
      await redis.withAbortSignal(AbortSignal.timeout(3000)).set(key, String(Date.now()), { EX: 40 });
    } catch { console.warn('Worker heartbeat unavailable'); }
    finally { heartbeatRunning = false; }
  }
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await worker.close();
    await Promise.allSettled([...finalizers]);
    if (redis.isReady) await redis.withAbortSignal(AbortSignal.timeout(3000)).del(key).catch(() => undefined);
    if (redis.isOpen) redis.destroy();
    await pool.end();
  };
  process.on('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.on('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
  void worker.run().catch(() => { process.exitCode = 1; void close().catch(() => console.error('Worker cleanup unavailable')); });
  await worker.waitUntilReady();
  await heartbeat();
  console.log(`BullMQ worker consuming ${settings.bullmqQueue}`);
}
main().catch(() => { console.error('Worker stopped; verify configuration and dependencies'); process.exitCode = 1; });
