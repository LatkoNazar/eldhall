import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfirmChannel, Options } from 'amqplib';
import { JOB_QUEUE, publishConfirmed } from '../src/core/queue.js';

test('publisher emits durable versioned envelope and resolves only after confirmation', async () => {
  let confirm: ((error: Error | null) => void) | undefined;
  const id = '00000000-0000-0000-0000-000000000001';
  const channel = {
    sendToQueue(queue: string, body: Buffer, options: Options.Publish, callback: (error: Error | null) => void) {
      assert.equal(queue, JOB_QUEUE);
      assert.deepEqual(JSON.parse(body.toString()), { version: 1, jobId: id });
      assert.equal(options.persistent, true);
      assert.equal(options.messageId, id);
      assert.equal(options.contentType, 'application/json');
      assert.deepEqual(options.headers, { 'x-attempt': 2 });
      confirm = callback;
      return true;
    },
  } as unknown as ConfirmChannel;
  let resolved = false;
  const publishing = publishConfirmed(channel, { version: 1, jobId: id }, 2).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.ok(confirm);
  confirm(null);
  await publishing;
  assert.equal(resolved, true);
});

test('publisher rejects synchronous errors and broker NACK without leaking details', async () => {
  const payload = { version: 1 as const, jobId: '00000000-0000-0000-0000-000000000001' };
  const throws = { sendToQueue() { throw new Error('secret-password'); } } as unknown as ConfirmChannel;
  await assert.rejects(publishConfirmed(throws, payload), { message: 'RabbitMQ publish failed' });
  const nacks = { sendToQueue(_queue: string, _body: Buffer, _options: Options.Publish, callback: (error: Error) => void) { callback(new Error('secret-password')); } } as unknown as ConfirmChannel;
  await assert.rejects(publishConfirmed(nacks, payload), { message: 'RabbitMQ publish was not confirmed' });
});
