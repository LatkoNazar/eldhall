import { createNodeRedisClient, Queue, type DefaultJobOptions } from 'bullmq';
import { createClient } from 'redis';
import type { Settings } from './config.js';
import { useCache } from './cache.js';

export interface JobMessage { jobId: string }
export const JOB_NAME = 'transform';

export function jobOptions(settings: Settings) {
  return {
    attempts: settings.bullmqAttempts,
    backoff: { type: 'exponential', delay: settings.bullmqBackoffMs },
    removeOnComplete: { age: settings.bullmqCompletedRetentionSeconds, count: settings.bullmqRetentionCount },
    removeOnFail: { age: settings.bullmqFailedRetentionSeconds, count: settings.bullmqRetentionCount },
  } satisfies DefaultJobOptions;
}

export function createWorkerRedis(settings: Settings) {
  const client = createClient({
    socket: {
      host: settings.redisHost, port: settings.redisPort, connectTimeout: 3000,
      reconnectStrategy: retries => Math.min(100 * 2 ** Math.min(retries, 5), 3000),
    },
    password: settings.redisPassword, database: settings.bullmqDb,
    disableOfflineQueue: false, commandsQueueMaxLength: 1000,
  });
  client.on('error', () => console.warn('Worker Redis connection unavailable; reconnecting'));
  return client;
}

export async function withQueue<T>(settings: Settings, operation: (queue: Queue<JobMessage, string | null, typeof JOB_NAME>) => Promise<T>): Promise<T> {
  // Independent finite producer connections reject offline commands rather than
  // buffering HTTP submissions. A later request reconnects after Redis recovers.
  return useCache(settings, settings.bullmqDb, async client => {
    const queue = new Queue<JobMessage, string | null, typeof JOB_NAME>(settings.bullmqQueue, {
      connection: createNodeRedisClient(client), prefix: settings.bullmqPrefix,
      skipWaitingForReady: true, defaultJobOptions: jobOptions(settings),
      streams: { events: { maxLen: 1000 } },
    });
    queue.on('error', () => console.warn('Queue connection unavailable'));
    try { return await operation(queue); }
    finally { await queue.close(); }
  });
}

export async function dispatchJob(settings: Settings, jobId: string): Promise<void> {
  await withQueue(settings, async queue => { await queue.add(JOB_NAME, { jobId }, { jobId }); });
}

export async function queueJobFailed(settings: Settings, jobId: string): Promise<boolean> {
  return withQueue(settings, async queue => {
    const job = await queue.getJob(jobId);
    return job ? await job.getState() === 'failed' : false;
  });
}

export function workerHeartbeatKey(settings: Settings, host: string): string {
  return `${settings.bullmqPrefix}:workers:${host}`;
}
