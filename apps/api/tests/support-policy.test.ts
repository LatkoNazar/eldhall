import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePolicy, duplicateCandidate } from '../src/modules/agent/policy.js';
import { seedData } from '../src/modules/support/seed.js';

test('duplicate refund requires the later captured charge in the same currency', () => {
  const seed = seedData();
  const customer = seed.customers.find(row => row.sessionToken === 'demo-olena')!;
  const business = seed.businesses.find(row => row.id === customer.businessId)!;
  const payments = seed.payments.filter(row => row.customerId === customer.id);
  const first = payments.find(row => row.id.endsWith('201'))!;
  const later = payments.find(row => row.id.endsWith('202'))!;
  const allowed = (id: string, rows = payments) => evaluatePolicy('refund_payment',
    { payment_id: id, amount_cents: later.amountCents },
    { business, customer, payments: rows, refunds: [], openProposals: [] }).allowed;
  assert.equal(allowed(later.id), true);
  assert.equal(allowed(first.id), false, 'the earlier charge is retained');
  const refunded = payments.map(row => row.id === later.id ? { ...row, status: 'refunded' as const } : row);
  assert.equal(allowed(first.id, refunded), false, 'a refunded later charge cannot justify refunding the remaining earlier charge');
  assert.equal(duplicateCandidate(refunded, business.policy.duplicateWindowMinutes), undefined);
  const mixed = payments.map(row => row.id === first.id ? { ...row, currency: 'EUR' } : row);
  assert.equal(allowed(later.id, mixed), false);
  const foreignCurrencyPair = payments.map(row => [first.id,later.id].includes(row.id) ? { ...row, currency: 'USD' } : row);
  assert.equal(allowed(later.id, foreignCurrencyPair), false, 'a UAH business limit cannot authorize a USD refund');
  const refundedTwin = payments.map(row => row.id === first.id ? { ...row, status: 'refunded' as const } : row);
  assert.equal(allowed(later.id, refundedTwin), false);
  const sameTime = payments.map(row => [first.id,later.id].includes(row.id) ? { ...row, createdAt: first.createdAt } : row);
  assert.equal(allowed(later.id, sameTime), true, 'equal timestamps use the stable payment id ordering');
  assert.equal(allowed(first.id, sameTime), false);
});
