import { hostname } from 'node:os';
import { getSettings } from './core/config.js';
import { JOB_QUEUE, publishConfirmed } from './core/queue.js';
import { processMessage } from './core/worker-runtime.js';
import { closeWorkerResources, openWorkerResources, retryWorkerStartup } from './core/worker-startup.js';
import { PostgresJobStore } from './modules/jobs/repository.js';

async function main() {
  const settings = getSettings();
  const resources = await retryWorkerStartup(() => openWorkerResources(settings));
  const { pool, cache, resultCache, connection, channel } = resources;
  const store = new PostgresJobStore(pool);
  const key = `node-worker:${hostname()}`;
  const inflight = new Set<Promise<void>>();
  let closing = false;
  let consumerTag: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let heartbeatRunning = false;
  let brokerReady = true;

  const close = async (failed = false) => {
    if (closing) return;
    closing = true;
    if (failed) process.exitCode = 1;
    if (timer) clearInterval(timer);
    if (consumerTag) await channel.cancel(consumerTag).catch(() => undefined);
    let shutdownTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise<void>(resolve => { shutdownTimeout = setTimeout(resolve, 25000); }),
    ]);
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
    if (cache.isReady) await cache.del(key).catch(() => undefined);
    await closeWorkerResources(resources);
  };
  const fail = () => { brokerReady = false; void close(true); };
  connection.on('close', () => { if (!closing) fail(); });
  channel.on('error', fail);
  channel.on('close', () => { if (!closing) fail(); });
  cache.on('error', fail);
  resultCache.on('error', fail);
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  try {
    const consumer = await channel.consume(JOB_QUEUE, message => {
      if (!message) { fail(); return; }
      const work = processMessage(message, {
        store, channel,
        publish: (payload, attempt) => publishConfirmed(channel, payload, attempt),
        onRetry: (id, attempt) => console.warn(`Background job retry confirmed: ${id} attempt=${attempt}`),
        cacheResult: async (id, result) => { await resultCache.withAbortSignal(AbortSignal.timeout(3000)).set(`node-task:${id}`, JSON.stringify({ status: 'SUCCESS', result }), { EX: 3600 }); },
      }).catch(() => { if (!closing) fail(); }).finally(() => { inflight.delete(work); });
      inflight.add(work);
    }, { noAck: false });
    consumerTag = consumer.consumerTag;
    const heartbeat = async () => {
      if (closing || heartbeatRunning || !brokerReady) return;
      heartbeatRunning = true;
      try {
        await pool.query('SELECT 1');
        await cache.withAbortSignal(AbortSignal.timeout(3000)).set(key, String(Date.now()), { EX: 40 });
      } catch { fail(); }
      finally { heartbeatRunning = false; }
    };
    await heartbeat();
    if (!closing) timer = setInterval(() => void heartbeat(), 10000);
    console.log(`Node worker consuming ${JOB_QUEUE}`);
  } catch {
    await close(true);
    throw new Error('Worker startup failed; verify configuration and dependencies');
  }
}
main().catch(() => { console.error('Worker stopped; verify configuration and dependencies'); process.exitCode = 1; });
