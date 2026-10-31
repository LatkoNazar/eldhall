import type { Settings } from '../../core/config.js';
import type pg from 'pg';
import { useCache } from '../../core/cache.js';

export type Checks = Record<string, () => Promise<unknown>>;
export function dependencyChecks(settings: Settings, pool: pg.Pool): Checks {
  return {
    postgres: () => pool.query('SELECT 1'),
    redis: () => useCache(settings, 0, cache => cache.ping()),
  };
}

export async function readiness(checks: Checks): Promise<Record<string, 'ok' | 'unavailable'>> {
  return Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    try { await check(); return [name, 'ok']; }
    catch { return [name, 'unavailable']; }
  })));
}
