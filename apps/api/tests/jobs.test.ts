import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, executeJob, MissingJob, QueueUnavailable, transform, UnsupportedOperation } from '../src/modules/jobs/service.js';
import { MemoryStore } from './helpers.js';

test('Unicode transforms preserve Python code-point behavior', () => {
  assert.equal(transform('привіт', 'uppercase'), 'ПРИВІТ');
  assert.equal(transform('straße', 'uppercase'), 'STRASSE');
  assert.equal(transform('привіт 🌍', 'reverse'), '🌍 тівирп');
  assert.throws(() => transform('hello', 'unknown'), UnsupportedOperation);
});

test('job lifecycle and completed redelivery', async () => {
  const store = new MemoryStore();
  const published: string[] = [];
  const job = await createJob(store, { text: 'hello' }, async id => { published.push(id); });
  assert.equal(job.status, 'queued');
  assert.deepEqual(published, [job.id]);
  assert.equal(await executeJob(store, job.id), 'HELLO');
  assert.equal((await store.find(job.id))?.status, 'succeeded');
  assert.equal(await executeJob(store, job.id), 'HELLO');
  await assert.rejects(executeJob(store, 'missing'), MissingJob);
});

test('broker failure persists a failed job after insert', async () => {
  const store = new MemoryStore();
  await assert.rejects(createJob(store, { text: 'hello' }, async id => {
    assert.equal((await store.find(id))?.status, 'queued');
    throw new Error('broker secret must not escape');
  }), QueueUnavailable);
  const job = [...store.jobs.values()][0]!;
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'Queue unavailable; submit a new job when service recovers');
});

test('unsupported operation persists a failed job', async () => {
  const store = new MemoryStore();
  const job = await store.create({ text: 'hello' });
  store.jobs.get(job.id)!.operation = 'unknown';
  await assert.rejects(executeJob(store, job.id), UnsupportedOperation);
  assert.equal((await store.find(job.id))?.error, 'Unsupported operation');
});

test('ambiguous publish failure and stale running update preserve terminal success', async () => {
  const store = new MemoryStore();
  await assert.rejects(createJob(store, { text: 'hello' }, async id => {
    await store.succeeded(id, 'HELLO');
    throw new Error('confirmation lost after worker completed');
  }), QueueUnavailable);
  const job = [...store.jobs.values()][0]!;
  await store.running(job.id);
  await store.failed(job.id, 'stale failure');
  assert.equal((await store.find(job.id))?.status, 'succeeded');
  assert.equal((await store.find(job.id))?.result, 'HELLO');
  assert.equal((await store.find(job.id))?.error, null);
});
