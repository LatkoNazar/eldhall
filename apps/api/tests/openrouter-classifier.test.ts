import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { classificationConfigSchema, type ClassificationInput } from '../src/modules/agent/classification.js';
import { OPENROUTER_DECISIONS_ENDPOINT, OpenRouterTicketClassifier } from '../src/modules/agent/openrouter-classifier.js';

const model = 'openai/gpt-6-luna-decisions';
const input: ClassificationInput = {
  businessId: 'private-business-id-not-needed-by-provider',
  taxonomy: classificationConfigSchema.parse({ revision: 1, fallbackClassId: 'other', classes: [
    { id: '1', label: 'Billing', description: 'Payments, invoices and duplicate charges.' },
    { id: '2', label: 'Delivery', description: 'Parcels, tracking and shipping delays.', examples: ['Where is my parcel?'] },
    { id: 'other', label: 'Other', description: 'The issue does not fit a specific category.' },
  ] }),
  history: [{ role: 'customer', body: 'I cannot track my parcel.' }],
  message: 'Where is my parcel? This is a synthetic test.',
};
const result = () => ({ model, answers: { ticket_class: { type: 'choice', choice: '2', confidence: 0.65,
  probabilities: { '1': 0.1, '2': 0.85, other: 0.05 } } } });

async function server(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const instance = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => { response.statusCode = 500; response.end(); }); });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); });
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/decisions`;
}

const classifier = (endpoint: string, overrides = {}) => new OpenRouterTicketClassifier({
  model, apiKey: 'synthetic-provider-credential', endpoint, allowInsecureLoopback: true, timeoutMs: 1000, ...overrides,
});

test('real Decisions HTTP request uses configured choices, scoped text, selected probability and independent provenance', async t => {
  let payload: Record<string, unknown> | undefined;
  const endpoint = await server(t, async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer synthetic-provider-credential');
    assert.equal(request.headers['content-type'], 'application/json');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result()));
  });
  const instance = classifier(endpoint);
  const decision = await instance.classify(input, new AbortController().signal);
  assert.equal(instance.provider, 'openrouter');
  assert.equal(instance.model, model);
  assert.equal(instance.scoreKind, 'selected_probability');
  assert.equal(decision.classId, '2');
  assert.equal(decision.confidence, 0.85); // Provider distribution confidence is0.65, a different quantity.
  assert.match(decision.reason, /selected-option probability/);
  assert.equal(payload?.model, model);
  assert.deepEqual(Object.keys((payload?.questions as { ticket_class: { criteria: object } }).ticket_class.criteria), ['1', '2', 'other']);
  assert.deepEqual(payload?.state, { conversation: input.history, message: input.message });
  assert.ok(!JSON.stringify(payload).includes(input.businessId));
  assert.ok(!JSON.stringify(payload).includes('synthetic-provider-credential'));
  assert.ok(!Object.hasOwn(payload!, 'tools'));
});

test('dated provider model aliases preserve the requested decision family', async t => {
  const endpoint = await server(t, (_request, response) => { response.end(JSON.stringify({ ...result(), model: `${model}-20261006` })); });
  assert.equal((await classifier(endpoint).classify(input, new AbortController().signal)).classId, '2');
});

test('unknown, incomplete, non-probability or inconsistent answers never become confident classifications', async t => {
  const invalid: unknown[] = [
    { ...result(), model: 'another/model' },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, choice: 'not-a-business-class' } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, probabilities: { '1': 0.1, '2': 0.9 } } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, probabilities: { '1': 0.1, '2': 0.85, other: 0.05, extra: 0 } } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, probabilities: { '1': 0.9, '2': 0.05, other: 0.05 } } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, probabilities: { '1': 0.9, '2': 0.8, other: 0.05 } } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, probabilities: { '1': -0.1, '2': 1.05, other: 0.05 } } } },
    { model, answers: { ticket_class: { ...result().answers.ticket_class, confidence: null } } },
    { model, answers: { ticket_class: { type: 'noul', noul: 0.95 } } },
  ];
  let index = 0;
  const endpoint = await server(t, (_request, response) => { response.end(JSON.stringify(invalid[index++])); });
  const instance = classifier(endpoint);
  for (let caseIndex = 0; caseIndex < invalid.length; caseIndex++) await assert.rejects(instance.classify(input, new AbortController().signal), /^Error: OpenRouter classification failed or returned an invalid decision$/);
  assert.equal(index, invalid.length);
});

test('errors and excessive responses are bounded and do not disclose provider error bodies', async t => {
  let index = 0;
  const endpoint = await server(t, (_request, response) => {
    if (index++ === 0) { response.statusCode = 401; response.end('private upstream message: synthetic-provider-credential'); }
    else response.end('x'.repeat(70000));
  });
  await assert.rejects(classifier(endpoint).classify(input, new AbortController().signal), /^Error: OpenRouter classification HTTP 401$/);
  await assert.rejects(classifier(endpoint).classify(input, new AbortController().signal), /^Error: OpenRouter classification failed or returned an invalid decision$/);
});

test('redirects never forward the classification credential to another target', async t => {
  let targetCalls = 0;
  const target = await server(t, (_request, response) => { targetCalls++; response.end(JSON.stringify(result())); });
  const endpoint = await server(t, (_request, response) => { response.statusCode = 302; response.setHeader('Location', target); response.end(); });
  await assert.rejects(classifier(endpoint).classify(input, new AbortController().signal), /failed or returned an invalid decision/);
  assert.equal(targetCalls, 0);
});

test('deadline and external cancellation terminate real in-flight classification requests', async t => {
  const endpoint = await server(t, () => {});
  await assert.rejects(classifier(endpoint, { timeoutMs: 30 }).classify(input, new AbortController().signal), /cancelled or timed out/);
  const controller = new AbortController();
  const pending = classifier(endpoint).classify(input, controller.signal);
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(pending, /cancelled or timed out/); } finally { clearTimeout(timer); }
});

test('invalid taxonomy and missing dedicated credentials make no HTTP request', async t => {
  let calls = 0;
  const endpoint = await server(t, (_request, response) => { calls++; response.end(JSON.stringify(result())); });
  await assert.rejects(classifier(endpoint, { apiKey: '' }).classify(input, new AbortController().signal), /key is not configured/);
  await assert.rejects(classifier(endpoint).classify({ ...input, taxonomy: { ...input.taxonomy, fallbackClassId: 'missing' } }, new AbortController().signal));
  assert.equal(calls, 0);
  assert.equal(OPENROUTER_DECISIONS_ENDPOINT, 'https://openrouter.ai/api/alpha/decisions');
  assert.throws(() => classifier('https://unrelated.example/decisions'), /fixed OpenRouter/);
  assert.throws(() => new OpenRouterTicketClassifier({ model, apiKey: 'synthetic', endpoint }), /fixed OpenRouter/);
});
