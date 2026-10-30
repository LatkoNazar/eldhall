import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConsumeMessage } from 'amqplib';
import { parseJobMessage, retryAttempt } from '../src/core/queue.js';
import { processMessage } from '../src/core/worker-runtime.js';
import { MemoryStore } from './helpers.js';

function message(jobId: string, attempt = 0): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ version: 1, jobId })),
    fields: { consumerTag: 'test', deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'test' },
    properties: {
      headers: { 'x-attempt': attempt }, contentType: 'application/json', contentEncoding: undefined,
      deliveryMode: 2, priority: undefined, correlationId: undefined, replyTo: undefined, expiration: undefined,
      messageId: jobId, timestamp: undefined, type: undefined, userId: undefined, appId: undefined, clusterId: undefined,
    },
  };
}

test('worker acknowledges after persisted result/cache and completed redelivery is safe', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc', operation: 'reverse' });
  const order: string[] = [];
  const dependencies = {
    store,
    channel: { ack: () => order.push('ack'), nack: () => order.push('nack') },
    publish: async () => { order.push('publish'); },
    cacheResult: async (id: string, result: string | null) => { assert.equal((await store.find(id))?.status, 'succeeded'); assert.equal(result, 'cba'); order.push('cache'); },
  };
  await processMessage(message(job.id), dependencies);
  assert.deepEqual(order, ['cache', 'ack']);
  await processMessage(message(job.id), dependencies);
  assert.deepEqual(order, ['cache', 'ack', 'cache', 'ack']);
});

test('transient failures republish confirmed attempt before ACK and stop after three retries', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc' });
  const order: string[] = [];
  const running = store.running.bind(store);
  store.running = async () => { throw new Error('database temporarily unavailable'); };
  const dependencies = {
    store,
    channel: { ack: () => order.push('ack'), nack: (_message: ConsumeMessage, _all?: boolean, requeue?: boolean) => { assert.equal(requeue, false); order.push('nack'); } },
    publish: async (_payload: unknown, attempt = 0) => { order.push(`confirmed:${attempt}`); },
    cacheResult: async () => undefined,
    pause: async () => { order.push('backoff'); },
  };
  await processMessage(message(job.id), dependencies);
  assert.deepEqual(order, ['backoff', 'confirmed:1', 'ack']);
  await processMessage(message(job.id, 3), dependencies);
  assert.equal(order.at(-1), 'nack');
  assert.equal((await store.find(job.id))?.status, 'failed');
  assert.equal(order.filter(item => item.startsWith('confirmed')).length, 1);
  store.running = running;
});

test('failed republish leaves original unacknowledged for connection recovery', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc' });
  store.running = async () => { throw new Error('database unavailable'); };
  let acknowledged = false;
  await assert.rejects(processMessage(message(job.id), {
    store, channel: { ack: () => { acknowledged = true; }, nack: () => { acknowledged = true; } },
    publish: async () => { throw new Error('broker unavailable'); }, cacheResult: async () => undefined, pause: async () => undefined,
  }), /broker unavailable/);
  assert.equal(acknowledged, false);
});

test('malformed messages and retry metadata are rejected without infinite requeue', async () => {
  for (const body of ['null', '[]', '{}', '{"version":2,"jobId":"x"}', '{broken']) assert.throws(() => parseJobMessage(Buffer.from(body)));
  for (const attempt of [-1, 4, '1', 0.5]) assert.throws(() => retryAttempt({ 'x-attempt': attempt }));
  const invalid = { ...message('00000000-0000-0000-0000-000000000000'), content: Buffer.from('{}') };
  let rejected = false;
  await processMessage(invalid, {
    store: new MemoryStore(), channel: { ack: () => assert.fail('must reject'), nack: (_message, _all, requeue) => { assert.equal(requeue, false); rejected = true; } },
    publish: async () => assert.fail('must not publish'), cacheResult: async () => assert.fail('must not cache'),
  });
  assert.equal(rejected, true);
});

test('a stale final-retry failure cannot overwrite a sibling delivery success', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc' });
  store.running = async () => { throw new Error('transient failure'); };
  const find = store.find.bind(store);
  let reads = 0;
  store.find = async id => {
    const snapshot = await find(id);
    if (++reads === 2) await store.succeeded(id, 'ABC');
    return snapshot;
  };
  await processMessage(message(job.id, 3), {
    store, channel: { ack: () => undefined, nack: () => undefined },
    publish: async () => assert.fail('retry limit reached'), cacheResult: async () => undefined,
  });
  assert.equal((await find(job.id))?.status, 'succeeded');
  assert.equal((await find(job.id))?.result, 'ABC');
  assert.equal((await find(job.id))?.error, null);
});
