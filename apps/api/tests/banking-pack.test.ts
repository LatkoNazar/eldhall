import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSupportConfig } from '../src/integrations/config.js';
import { readSkillTree, toSupportConfig } from '../src/modules/knowledge/skill-md.js';
import { parseSkillContext } from '../src/modules/agent/context.js';
import { seedData } from '../src/modules/support/seed.js';
import { duplicateCandidate, evaluatePolicy } from '../src/modules/agent/policy.js';
import type { Customer, Payment } from '../src/modules/support/contracts.js';

const pack = new URL('../../../examples/banking/', import.meta.url);
test('banking example registers one workspace and exact versioned Markdown procedures and facts', async () => {
  const config = await loadSupportConfig(fileURLToPath(new URL('support.config.json', pack)));
  assert.equal(config.businesses.length, 1);
  const business = config.businesses[0]!;
  const imported = toSupportConfig(await readSkillTree(fileURLToPath(new URL('skills', pack))), business.id, business.slug);
  assert.equal(imported.skills.length, 8); assert.equal(imported.knowledge.length, 5);
  assert.deepEqual(config.skills, imported.skills); assert.deepEqual(config.knowledge, imported.knowledge);
  assert.ok(config.skills.every(row => row.businessId === business.id && row.enabled && row.revision > 0));
  const lazy = config.skills.filter(skill => parseSkillContext(skill).activation === 'on_demand');
  assert.deepEqual(lazy.map(skill => skill.name).sort(), ['banking-card-support', 'banking-complaints', 'banking-fees-statements', 'banking-refunds', 'banking-transfers'].map(name => `universal/${name}`));
  assert.ok(lazy.every(skill => skill.revision === 2));
  assert.deepEqual(config.skills.filter(skill => !lazy.includes(skill)).map(skill => [skill.name, skill.revision]), [['universal/banking-evidence', 1], ['universal/banking-security', 1], ['universal/banking-workflow', 2]]);
  assert.ok(config.knowledge.every(row => row.businessId === business.id && row.status === 'published' && row.audience === 'customer'));
  assert.equal(config.guardPolicies.length, 1); assert.equal(config.guardPolicies[0]!.businessId, business.id);
  assert.equal(config.guardPolicies[0]!.revision, 1);
  assert.deepEqual(config.guardPolicies[0]!.guards.map(row => row.kind).sort(), ['amount_limit', 'deny_action', 'require_approval']);
  assert.equal(config.guardPolicies[0]!.guards.find(row => row.kind === 'deny_action')!.enabled, false);
});

test('banking fixtures stay disjoint from preserved demos and represent eligible, single and over-limit payments', async () => {
  const config = await loadSupportConfig(fileURLToPath(new URL('support.config.json', pack)));
  const data = JSON.parse(await readFile(new URL('sandbox-data.v1.json', pack), 'utf8')) as { businessId: string; customers: Customer[]; payments: Payment[] };
  const business = config.businesses[0]!;
  assert.equal(data.businessId, business.id); assert.equal(data.customers.length, 6);
  const old = seedData(); const oldIds = new Set([...old.businesses, ...old.customers, ...old.payments].map(row => row.id));
  assert.ok([business, ...data.customers, ...data.payments].every(row => !oldIds.has(row.id)));
  assert.equal(new Set(data.customers.map(row => row.sessionToken)).size, data.customers.length);
  assert.ok(data.customers.every(row => row.businessId === business.id && row.email.endsWith('@bank.example.test') && row.sessionToken.startsWith('bank-sandbox-')));
  assert.ok(data.payments.every(row => data.customers.some(customer => customer.id === row.customerId) && row.currency === business.currency));
  const evaluate = (index: number) => {
    const customer = data.customers[index]!; const payments = data.payments.filter(row => row.customerId === customer.id);
    const candidate = duplicateCandidate(payments, business.policy.duplicateWindowMinutes);
    return { candidate, result: candidate && evaluatePolicy('refund_payment', { payment_id: candidate.id, amount_cents: candidate.amountCents }, { business, customer, payments, refunds: [], openProposals: [] }) };
  };
  assert.equal(evaluate(0).result?.allowed, true);
  assert.equal(evaluate(1).candidate, undefined);
  assert.equal(evaluate(2).result?.allowed, false);
  assert.equal(evaluate(3).result?.allowed, true);
  assert.equal(evaluate(4).result?.allowed, true);
  assert.equal(evaluate(5).candidate, undefined);
});
