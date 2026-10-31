import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { jobReference, persistQueueFailure, processJob } from '../src/modules/jobs/processor.js';
import { readJob } from '../src/modules/jobs/service.js';
import { MemoryStore } from './helpers.js';

test('BullMQ processor returns SQL result and tolerates completed redelivery', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'привіт 🌍', operation: 'reverse' });
  const queued = { name: 'transform', data: { jobId: job.id } };
  assert.equal(await processJob(queued, store), '🌍 тівирп');
  assert.equal(await processJob(queued, store), '🌍 тівирп');
  assert.equal((await store.find(job.id))?.status, 'succeeded');
});

test('invalid task references are unrecoverable while SQL errors remain retryable', async () => {
  const store = new MemoryStore();
  for (const data of [null, [], {}, { jobId: 'invalid' }]) assert.throws(() => jobReference(data), UnrecoverableError);
  await assert.rejects(processJob({ name: 'other', data: { jobId: 'bad' } }, store), UnrecoverableError);
  await assert.rejects(processJob({ name: 'transform', data: { jobId: '00000000-0000-0000-0000-000000000001' } }, store), UnrecoverableError);
  const job = await store.create({ text: 'hello' });
  store.running = async () => { throw new Error('SQL unavailable'); };
  await assert.rejects(processJob({ name: 'transform', data: { jobId: job.id } }, store), error => error instanceof Error && !(error instanceof UnrecoverableError));
});

test('intermediate failures do not mark SQL failed; terminal queue failure preserves success', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc' });
  await persistQueueFailure({ data: { jobId: job.id }, getState: async () => 'delayed' }, store);
  assert.equal((await store.find(job.id))?.status, 'queued');
  await persistQueueFailure({ data: { jobId: job.id }, getState: async () => 'failed' }, store);
  assert.equal((await store.find(job.id))?.status, 'failed');
  await store.succeeded(job.id, 'ABC');
  await persistQueueFailure({ data: { jobId: job.id }, getState: async () => 'failed' }, store);
  assert.equal((await store.find(job.id))?.status, 'succeeded');
  assert.equal((await store.find(job.id))?.error, null);
});

test('reads repair a missed terminal update after SQL recovery and tolerate unavailable queue metadata', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'abc' });
  assert.equal((await readJob(store, job.id, async () => { throw new Error('Redis down'); }))?.status, 'queued');
  assert.equal((await readJob(store, job.id, async () => true))?.status, 'failed');
  await store.succeeded(job.id, 'ABC');
  const completed = await readJob(store, job.id, async () => assert.fail('SQL result needs no queue metadata'));
  assert.equal(completed?.status, 'succeeded');
});
