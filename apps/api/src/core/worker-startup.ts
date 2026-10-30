import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type { Settings } from './config.js';
import { createPool } from './database.js';
import { createCache, type Cache } from './cache.js';
import { assertJobQueue, connectBroker } from './queue.js';

interface Factories {
  pool: (settings: Settings) => pg.Pool;
  cache: (settings: Settings, database: number) => Cache;
  broker: (settings: Settings) => Promise<ChannelModel>;
}
export interface WorkerResources {
  pool: pg.Pool;
  cache: Cache;
  resultCache: Cache;
  connection: ChannelModel;
  channel: ConfirmChannel;
}

export async function closeWorkerResources(resources: Partial<WorkerResources>): Promise<void> {
  await resources.channel?.close().catch(() => undefined);
  await resources.connection?.close().catch(() => undefined);
  if (resources.cache?.isOpen) resources.cache.destroy();
  if (resources.resultCache?.isOpen) resources.resultCache.destroy();
  await resources.pool?.end();
}

export async function openWorkerResources(settings: Settings, factories: Factories = { pool: createPool, cache: createCache, broker: connectBroker }): Promise<WorkerResources> {
  const resources: Partial<WorkerResources> = {};
  try {
    resources.pool = factories.pool(settings);
    resources.cache = factories.cache(settings, 0);
    resources.resultCache = factories.cache(settings, 1);
    await resources.pool.query('SELECT 1');
    await resources.cache.connect();
    await resources.resultCache.connect();
    resources.connection = await factories.broker(settings);
    resources.channel = await resources.connection.createConfirmChannel();
    resources.channel.on('error', () => console.warn('RabbitMQ worker channel unavailable'));
    await assertJobQueue(resources.channel);
    await resources.channel.prefetch(settings.workerConcurrency);
    return resources as WorkerResources;
  } catch {
    await closeWorkerResources(resources);
    throw new Error('Worker dependencies unavailable');
  }
}

export async function retryWorkerStartup<T>(open: () => Promise<T>, pause: (milliseconds: number) => Promise<unknown> = delay): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await open(); }
    catch (error) {
      if (attempt === 4) throw error;
      console.warn(`Worker startup unavailable; retry ${attempt + 1}/4`);
      await pause(1000 * 2 ** attempt);
    }
  }
  throw new Error('Worker startup attempts exhausted');
}
