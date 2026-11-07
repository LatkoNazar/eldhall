// Deterministic OpenAI-compatible chat endpoint for the sidecar smoke test (no paid model, no network).
// It drives the real DSH runtime: request checkpoint → canonical request targets → status/cancel business tool;
// call_business_tool cancel_order; then submit_decision with a reply built from the tool result it actually got,
// so the smoke proves that MCP data reached the model. Run: PORT=8080 node deploy/smoke/fake-llm.mjs
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text ?? '').join('') : JSON.stringify(value ?? '');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decision = reply => ({ tool: 'submit_decision', args: { intent: 'other', summary: 'Order request', reasoning: 'Business tool result', sentiment: { label: 'calm', urgency: 'low' }, reply, action: null } });

function applicationContext(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'user') continue;
    let value;
    try { value = JSON.parse(text(messages[index].content)); }
    catch { continue; /* Runtime/user prose is not the application context. */ }
    if (!record(value)) continue;
    if (Object.hasOwn(value, 'contextMemory')) {
      const memory = value.contextMemory, current = memory?.currentMessage;
      if (!record(memory) || memory.schemaVersion !== 1 || !record(current) || current.role !== 'customer' || !uuid(current.id) || typeof current.body !== 'string'
        || !record(memory.requestCatalog) || (value.currentCustomerMessageId !== undefined && value.currentCustomerMessageId !== current.id)) throw new Error('Smoke fixture requires canonical context memory');
      // The current message and compact catalog moved into memory. Never pick a recent
      // message, an old native turn, or request titles as the current customer input.
      return { ...value, message: current.body, currentCustomerMessageId: current.id, requestCatalog: memory.requestCatalog,
        requestSourceMessages: [{ id: current.id, body: current.body }] };
    }
    if (typeof value.message === 'string') return value;
  }
  throw new Error('Smoke fixture requires application context');
}

function canonicalCatalog(content) {
  let value = content;
  for (let depth = 0; depth < 4; depth++) {
    if (record(value) && record(value.requestCatalog)) return value.requestCatalog;
    if (record(value) && 'result' in value) { value = value.result; continue; }
    try { value = JSON.parse(text(value)); } catch { break; }
  }
  throw new Error('Smoke request checkpoint was not accepted');
}

function businessStep(context, catalog) {
  const orderId = /ORD-\d{4}/.exec(context.message)?.[0];
  if (!orderId) return decision('Підкажіть номер замовлення.');
  const args = { integrationId: 'orders', name: /Скасуйте|cancel/i.test(context.message) ? 'cancel_order' : 'get_order_status', input: { order_id: orderId } };
  if (args.name === 'cancel_order') args.input.reason = 'customer request';
  if (catalog) {
    if (!Array.isArray(catalog.requests)) throw new Error('Smoke fixture requires canonical request records');
    const matching = catalog.requests.filter(row => record(row) && row.lifecycle === 'open' && row.goal === context.message && row.sourceMessageIds?.includes(context.currentCustomerMessageId));
    if (matching.length !== 1 || !uuid(matching[0].id) || !Number.isInteger(matching[0].revision) || matching[0].revision < 1) throw new Error('Smoke fixture requires an unambiguous canonical request target');
    args.requests = [{ id: matching[0].id, revision: matching[0].revision }];
  }
  return { tool: 'call_business_tool', args };
}

export function decide(messages) {
  const context = applicationContext(messages);
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const calls = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls;
    const call = (calls?.find(call => call.id === last.tool_call_id) ?? calls?.at(-1))?.function?.name;
    if (call === 'submit_decision') return { content: 'Готово.' };
    if (call === 'update_customer_requests') return businessStep(context, canonicalCatalog(last.content));
    const result = text(last.content);
    const status = /"status"\s*:\s*"([a-z_]+)"/.exec(result)?.[1];
    const reply = /awaiting_approval/.test(result) ? 'Запит передано на підтвердження спеціалісту.'
      : status ? `Статус замовлення: ${status}.` : 'Не вдалося отримати дані замовлення.';
    return decision(reply);
  }
  if (context.requestCatalog !== undefined) {
    const catalog = context.requestCatalog;
    if (!record(catalog) || !Number.isInteger(catalog.version) || catalog.version < 0 || !Array.isArray(catalog.requests) || !uuid(context.currentCustomerMessageId)
      || !context.requestSourceMessages?.some(source => source.id === context.currentCustomerMessageId && source.body === context.message)) throw new Error('Smoke fixture requires canonical request source context');
    if (catalog.lastSourceMessageId === context.currentCustomerMessageId) return businessStep(context, catalog);
    const orderId = /ORD-\d{4}/.exec(context.message)?.[0];
    const matching = catalog.requests.filter(row => row.lifecycle === 'open' && row.goal === context.message);
    if (matching.length > 1) throw new Error('Smoke fixture cannot guess request identity');
    const prior = matching[0];
    return { tool: 'update_customer_requests', args: { version: catalog.version, syncState: orderId ? 'current' : 'needs_review', changes: orderId ? [{
      localKey: 'order-request', ...(prior ? { id: prior.id, expectedRevision: prior.revision } : {}),
      title: `${/Скасуйте|cancel/i.test(context.message) ? 'Cancel order' : 'Order status'} ${orderId}`,
      goal: context.message, waitingOn: null, nextStep: null, sourceMessageIds: [context.currentCustomerMessageId], dependencyIds: [], dependencyKeys: [],
    }] : [] } };
  }
  // Legacy source fixtures without the request-catalog protocol retain their original tool flow.
  return businessStep(context);
}

export function createFakeLlmServer() { return createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(); return; }
    if (process.env.FAKE_LLM_DEBUG) console.log(JSON.stringify((body.messages ?? []).map(m => ({ role: m.role, content: text(m.content).slice(0, 300), tools: m.tool_calls?.map(c => c.function?.name) }))));
    let step;
    try { step = decide(body.messages ?? []); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"Invalid smoke request context"}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (step.tool) {
      chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: step.content });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
}); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  createFakeLlmServer().listen(port, host, () => console.log(`fake llm on http://${host}:${port}/v1`));
}
