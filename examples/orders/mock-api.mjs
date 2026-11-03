// Synthetic Orders API for integration tests and local demos (examples/orders/openapi.json).
// Upstream enforces its own auth, customer ownership and cancel-before-shipment; no real data.
// Run: ORDERS_API_TOKEN=local-orders-token node examples/orders/mock-api.mjs  (port 8090 or $PORT)
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const seed = ({ olena, taras }) => new Map([
  ['ORD-1001', { order_id: 'ORD-1001', customer: olena, status: 'paid', total_cents: 49900, currency: 'UAH', tracking_url: null, internal_note: 'VIP, margin 12%' }],
  ['ORD-1002', { order_id: 'ORD-1002', customer: olena, status: 'shipped', total_cents: 129900, currency: 'UAH', tracking_url: 'https://track.example/ORD-1002', internal_note: 'warehouse B' }],
  ['ORD-1003', { order_id: 'ORD-1003', customer: olena, status: 'paid', total_cents: 25900, currency: 'UAH', tracking_url: null, internal_note: 'gift wrap' }],
  ['ORD-2001', { order_id: 'ORD-2001', customer: taras, status: 'paid', total_cents: 9900, currency: 'UAH', tracking_url: null, internal_note: 'fraud review cleared' }],
]);

// `customers` lets a test own the orders under ids the backend actually sends (e.g. seeded Eldhall customer ids).
// `controlToken` (tests only) enables /__test/owners and /__test/orders/:id to assign owners after the backend
// created its customers, and to read an order's real state; without it those routes do not exist.
export function createOrdersApi({ token, customers = { olena: 'cust-olena', taras: 'cust-taras' }, controlToken }) {
  if (!token) throw new Error('token is required');
  let orders = seed(customers);
  const replays = new Map(); // `${customer}\0${key}` -> { orderId, status, body }
  const writes = new Map(); // order id -> cancel requests that reached business logic (not idempotent replays)
  const counters = new Map(); // order id -> { cancelRequests, foreignReads } as seen by this upstream
  const count = (id, field) => { const row = counters.get(id) ?? { cancelRequests: 0, foreignReads: 0 }; row[field]++; counters.set(id, row); };
  const view = ({ customer: _, ...order }) => order;
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 16_384) req.destroy(); });
    req.on('end', () => {
      if (controlToken && req.url?.startsWith('/__test/')) {
        if (req.headers['x-test-control'] !== controlToken) return send(res, 401, { error: 'unauthorized' });
        if (req.method === 'POST' && req.url === '/__test/owners') {
          let owners;
          try { owners = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_json' }); }
          if (typeof owners?.olena !== 'string' || typeof owners?.taras !== 'string') return send(res, 400, { error: 'olena_and_taras_required' });
          orders = seed(owners); replays.clear(); writes.clear(); counters.clear();
          return send(res, 200, { orders: [...orders.keys()] });
        }
        const found = /^\/__test\/orders\/([^/]+)$/.exec(req.url);
        const order = found && orders.get(decodeURIComponent(found[1]));
        return order ? send(res, 200, { ...order, writes: writes.get(order.order_id) ?? 0, cancelRequests: 0, foreignReads: 0, ...counters.get(order.order_id) }) : send(res, 404, { error: 'order_not_found' });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
      const customer = req.headers['x-customer-id'];
      if (typeof customer !== 'string' || !customer) return send(res, 400, { error: 'missing_customer_scope' });
      const url = new URL(req.url ?? '/', 'http://orders.local');
      const match = /^\/orders\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      const order = match && orders.get(decodeURIComponent(match[1]));
      if (order && match[2] && req.method === 'POST') count(order.order_id, 'cancelRequests');
      if (order && order.customer !== customer) count(order.order_id, 'foreignReads');
      // Not found and not owned look identical, so ids cannot be probed across customers.
      if (!match || !order || order.customer !== customer) return send(res, 404, { error: 'order_not_found' });
      if (!match[2] && req.method === 'GET') return send(res, 200, view(order));
      if (!match[2] || req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key || key.length > 100) return send(res, 400, { error: 'idempotency_key_required' });
      try { if (raw) JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const replay = replays.get(`${customer}\0${key}`);
      if (replay) return replay.orderId === order.order_id ? send(res, replay.status, replay.body) : send(res, 422, { error: 'idempotency_key_reused' });
      writes.set(order.order_id, (writes.get(order.order_id) ?? 0) + 1);
      const result = order.status === 'paid'
        ? (order.status = 'cancelled', { status: 200, body: view(order) })
        : { status: 409, body: { error: 'not_cancellable', status: order.status } };
      replays.set(`${customer}\0${key}`, { orderId: order.order_id, ...result });
      send(res, result.status, result.body);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8090);
  const host = process.env.HOST ?? '127.0.0.1';
  createOrdersApi({ token: process.env.ORDERS_API_TOKEN, controlToken: process.env.ORDERS_TEST_CONTROL_TOKEN })
    .listen(port, host, () => console.log(`orders mock on http://${host}:${port}`));
}
