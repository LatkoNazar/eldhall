import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createFakeLlmServer, decide } from '../../deploy/smoke/fake-llm.mjs';

const messageId = '00000000-0000-4000-8000-000000000101';
const requestId = '00000000-0000-4000-8000-000000000202';
const context = (message = 'Скасуйте замовлення ORD-1001') => ({ message, currentCustomerMessageId: messageId,
  requestSourceMessages: [{ id: messageId, body: message }], requestCatalog: { version: 7, lastSourceMessageId: null, requests: [] } });
const user = value => ({ role: 'user', content: JSON.stringify(value) });
const accepted = value => ({ version: 8, lastSourceMessageId: messageId, requests: [{ id: requestId, revision: 3, lifecycle: 'open', goal: value.message, sourceMessageIds: [messageId] }] });
const toolResult = (name, value) => [
  { role: 'assistant', tool_calls: [{ id: 'fixture-call', function: { name } }] },
  { role: 'tool', tool_call_id: 'fixture-call', content: typeof value === 'string' ? value : JSON.stringify(value) },
];

test('first turn checkpoints the actual context version and source before calling business tools', () => {
  const value = context(); const step = decide([user(value)]);
  assert.equal(step.tool, 'update_customer_requests'); assert.equal(step.args.version, 7);
  assert.deepEqual(step.args.changes[0].sourceMessageIds, [messageId]); assert.equal(step.args.changes[0].goal, value.message);
  assert.equal(step.args.changes[0].id, undefined);
});

test('accepted checkpoint supplies exact canonical write targets outside upstream input', () => {
  const value = context(); const step = decide([user(value), ...toolResult('update_customer_requests', { requestCatalog: accepted(value) })]);
  assert.equal(step.tool, 'call_business_tool'); assert.equal(step.args.name, 'cancel_order');
  assert.deepEqual(step.args.requests, [{ id: requestId, revision: 3 }]);
  assert.deepEqual(step.args.input, { order_id: 'ORD-1001', reason: 'customer request' });
});

test('status read also follows checkpoint and uses only the latest application message', () => {
  const old = context('Скасуйте замовлення ORD-1001'); const current = context('Який статус ORD-1002?');
  const first = decide([user(old), user(current)]); assert.equal(first.tool, 'update_customer_requests'); assert.equal(first.args.changes[0].goal, current.message);
  const step = decide([user(old), user(current), ...toolResult('update_customer_requests', { requestCatalog: accepted(current) })]);
  assert.equal(step.args.name, 'get_order_status'); assert.deepEqual(step.args.input, { order_id: 'ORD-1002' });
});

test('checkpoint replay uses already canonical IDs without rewriting the checkpoint', () => {
  const value = context(); value.requestCatalog = accepted(value);
  assert.deepEqual(decide([user(value)]).args.requests, [{ id: requestId, revision: 3 }]);
});

test('failed, malformed or ambiguous checkpoint never produces an unlinked business write', () => {
  const value = context();
  for (const result of ['Error: checkpoint denied', { requestCatalog: { requests: [] } }, { requestCatalog: { requests: [...accepted(value).requests, ...accepted(value).requests] } }]) {
    assert.throws(() => decide([user(value), ...toolResult('update_customer_requests', result)]));
  }
  assert.throws(() => decide([user({ ...value, currentCustomerMessageId: 'invented-source' })]));
});

test('final read reply still comes from the actual tool result; pending never claims execution', () => {
  const value = context('Який статус ORD-1002?');
  assert.equal(decide([user(value), ...toolResult('call_business_tool', { result: { status: 'shipped' } })]).args.reply, 'Статус замовлення: shipped.');
  assert.equal(decide([user(value), ...toolResult('call_business_tool', { status: 'awaiting_approval' })]).args.reply, 'Запит передано на підтвердження спеціалісту.');
  assert.equal(decide([user(value), ...toolResult('call_business_tool', 'Error: upstream denied')]).args.reply, 'Не вдалося отримати дані замовлення.');
});

test('non-order input records review without inventing a business action; legacy fixture remains supported', () => {
  const value = context('Потрібна допомога'); const first = decide([user(value)]);
  assert.equal(first.tool, 'update_customer_requests'); assert.equal(first.args.syncState, 'needs_review'); assert.deepEqual(first.args.changes, []);
  assert.equal(decide([user(value), ...toolResult('update_customer_requests', { requestCatalog: { requests: [] } })]).tool, 'submit_decision');
  assert.equal(decide([user({ message: 'Який статус ORD-1002?' })]).args.name, 'get_order_status');
});

test('HTTP fixture emits the checkpoint through the existing streaming protocol', async () => {
  const server = createFakeLlmServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [user(context())] }) });
    assert.equal(response.status, 200); const output = await response.text(); assert.match(output, /update_customer_requests/); assert.match(output, /\[DONE\]/); assert.doesNotMatch(output, /"name":"call_business_tool"/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
