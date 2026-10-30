import { hostname } from 'node:os';
import { getSettings } from '../core/config.js';
import { useCache } from '../core/cache.js';

useCache(getSettings(), 0, async cache => {
  const value = await cache.get(`node-worker:${hostname()}`);
  if (!value || Date.now() - Number(value) > 35000 || !Number.isFinite(Number(value))) throw new Error('Worker heartbeat unavailable');
}).catch(() => { console.error('Worker heartbeat unavailable'); process.exitCode = 1; });
