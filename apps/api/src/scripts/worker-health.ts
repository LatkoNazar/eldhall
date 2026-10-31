import { hostname } from 'node:os';
import { getSettings } from '../core/config.js';
import { useCache } from '../core/cache.js';
import { workerHeartbeatKey } from '../core/queue.js';

const settings = getSettings();
useCache(settings, settings.bullmqDb, async cache => {
  const value = await cache.get(workerHeartbeatKey(settings, hostname()));
  if (!value || Date.now() - Number(value) > 35000 || !Number.isFinite(Number(value))) throw new Error('Worker heartbeat unavailable');
}).catch(() => { console.error('Worker heartbeat unavailable'); process.exitCode = 1; });
