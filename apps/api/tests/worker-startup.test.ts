import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type { Cache } from '../src/core/cache.js';
import { settingsFrom } from '../src/core/config.js';
import { closeWorkerResources, openWorkerResources, retryWorkerStartup } from '../src/core/worker-startup.js';

test('transient worker startup failure closes partial resources before a successful retry', async () => {
  let attempt = 0;
  const events: string[] = [];
  const pauses: number[] = [];
  const factories = {
    pool: () => {
      const current = ++attempt;
      events.push(`pool.open:${current}`);
      return { query: async () => undefined, end: async () => { events.push(`pool.close:${current}`); } } as unknown as pg.Pool;
    },
    cache: (_settings: unknown, database: number) => {
      const current = attempt;
      let opened = false;
      return { get isOpen() { return opened; }, connect: async () => { opened = true; }, destroy: () => { opened = false; events.push(`redis${database}.close:${current}`); } } as unknown as Cache;
    },
    broker: async () => {
      const current = attempt;
      const channel = {
        on: () => channel,
        assertQueue: async (_name: string, options: { durable: boolean }) => {
          assert.equal(options.durable, true);
          if (current === 1) throw new Error('broker became ready after initial handshake');
        },
        prefetch: async (count: number) => { assert.equal(count, 2); },
        close: async () => { events.push(`channel.close:${current}`); },
      } as unknown as ConfirmChannel;
      return { createConfirmChannel: async () => channel, close: async () => { events.push(`broker.close:${current}`); } } as unknown as ChannelModel;
    },
  };
  const resources = await retryWorkerStartup(() => openWorkerResources(settingsFrom({}), factories), async milliseconds => { pauses.push(milliseconds); });
  assert.equal(attempt, 2);
  assert.deepEqual(pauses, [1000]);
  for (const name of ['channel', 'broker', 'redis0', 'redis1', 'pool']) {
    assert.ok(events.indexOf(`${name}.close:1`) < events.indexOf('pool.open:2'), name);
    assert.ok(events.includes(`${name}.close:1`), name);
  }
  await closeWorkerResources(resources);
  assert.ok(events.includes('pool.close:2'));
});

test('worker startup retry stops after five cleaned attempts with bounded backoff', async () => {
  let attempts = 0;
  const pauses: number[] = [];
  await assert.rejects(retryWorkerStartup(async () => { attempts++; throw new Error('unavailable'); }, async milliseconds => { pauses.push(milliseconds); }), /unavailable/);
  assert.equal(attempts, 5);
  assert.deepEqual(pauses, [1000, 2000, 4000, 8000]);
});
