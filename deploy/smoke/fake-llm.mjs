// Deterministic OpenAI-compatible chat endpoint for the sidecar smoke test (no paid model, no network).
// It drives the real DSH runtime: a status question → call_business_tool get_order_status; a cancel request →
// call_business_tool cancel_order; then submit_decision with a reply built from the tool result it actually got,
// so the smoke proves that MCP data reached the model. Run: PORT=8080 node deploy/smoke/fake-llm.mjs
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text ?? '').join('') : JSON.stringify(value ?? '');

function decide(messages) {
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const call = messages.findLast(message => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls?.at(-1)?.function?.name;
    if (call === 'submit_decision') return { content: 'Готово.' };
    const result = text(last.content);
    const status = /"status"\s*:\s*"([a-z_]+)"/.exec(result)?.[1];
    const reply = /awaiting_approval/.test(result) ? 'Запит передано на підтвердження спеціалісту.'
      : status ? `Статус замовлення: ${status}.` : 'Не вдалося отримати дані замовлення.';
    return { tool: 'submit_decision', args: { intent: 'other', summary: 'Order request', reasoning: 'Business tool result', sentiment: { label: 'calm', urgency: 'low' }, reply, action: null } };
  }
  // DSH sends the application context as a JSON user message whose `message` field is the customer's text, plus
  // runtime snapshots; only the customer's own words decide the scripted step.
  const user = messages.filter(message => message.role === 'user').map(message => {
    try { const context = JSON.parse(text(message.content)); return typeof context?.message === 'string' ? context.message : ''; } catch { return ''; }
  }).join(' ');
  const orderId = /ORD-\d{4}/.exec(user)?.[0];
  if (orderId && /Скасуйте|cancel/i.test(user)) return { tool: 'call_business_tool', args: { integrationId: 'orders', name: 'cancel_order', input: { order_id: orderId, reason: 'customer request' } } };
  if (orderId) return { tool: 'call_business_tool', args: { integrationId: 'orders', name: 'get_order_status', input: { order_id: orderId } } };
  return { tool: 'submit_decision', args: { intent: 'other', summary: 'General question', reasoning: 'No order reference', sentiment: { label: 'calm', urgency: 'low' }, reply: 'Підкажіть номер замовлення.', action: null } };
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(); return; }
    if (process.env.FAKE_LLM_DEBUG) console.log(JSON.stringify((body.messages ?? []).map(m => ({ role: m.role, content: text(m.content).slice(0, 300), tools: m.tool_calls?.map(c => c.function?.name) }))));
    const step = decide(body.messages ?? []);
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
}).listen(port, host, () => console.log(`fake llm on http://${host}:${port}/v1`));
