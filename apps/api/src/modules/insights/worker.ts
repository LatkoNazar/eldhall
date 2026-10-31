import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { InsightsService } from './service.js';

/** Durable PostgreSQL polling, deliberately separate from customer-turn BullMQ delivery. */
export function startInsightsWorker(service: InsightsService) {
  const owner = `insights:${hostname()}:${randomUUID()}`;
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  let running = true;
  const tick = () => {
    if (pending || controller.signal.aborted) return;
    pending = service.processOne(owner, controller.signal).then(() => undefined)
      .catch(() => console.warn('Insights storage unavailable; durable analyses will recover'))
      .finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, 2000);
  tick();
  return { isRunning: () => running, async close() { running = false; clearInterval(timer); controller.abort(new Error('Worker stopping')); await pending; } };
}
