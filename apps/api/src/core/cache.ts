import { createClient } from 'redis';
import type { Settings } from './config.js';

export function createCache(settings: Settings, database = 0) {
  const client = createClient({
    socket: { host: settings.redisHost, port: settings.redisPort, connectTimeout: 3000, reconnectStrategy: false },
    password: settings.redisPassword, database,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 100,
  });
  client.on('error', () => console.warn('Redis connection unavailable'));
  return client;
}

export type Cache = ReturnType<typeof createCache>;

export async function useCache<T>(settings: Settings, database: number, callback: (cache: Cache) => Promise<T>): Promise<T> {
  const cache = createCache(settings, database);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => { await cache.connect(); return callback(cache); })(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Redis operation timed out')), 3000); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cache.isOpen) cache.destroy();
  }
}
