import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseSkillContext, type ContextMessage } from '../src/modules/agent/context.js';
import { createSupportContextAccess } from '../src/modules/agent/context-access.js';
import { buildSupportContextMemory } from '../src/modules/agent/context-memory.js';
import { emptyCatalog } from '../src/modules/support/requests/engine.js';
import type { CustomerRequest } from '../src/modules/support/requests/contracts.js';
import type { Proposal } from '../src/modules/support/contracts.js';

test('only explicitly valid optional metadata can defer instructions; malformed skills remain mandatory', () => {
  const body = 'Keep this exact instruction.';
  const optional = parseSkillContext({ name: 'delivery', content: '---\nactivation: on_demand\ndescription: Delivery support\n---\n' + body });
  assert.equal(optional.activation, 'on_demand'); assert.equal(optional.content, body);
  for (const content of [
    body, '---\nactivation: unknown\ndescription: Support\n---\n' + body,
    '---\nactivation: on_demand\n---\n' + body,
    '---\nactivation: on_demand\nactivation: always\ndescription: Support\n---\n' + body,
    '---\nactivation: on_demand\ndescription: |\n  Multiline\n---\n' + body,
  ]) { const skill = parseSkillContext({ name: 'core', content }); assert.equal(skill.activation, 'always'); assert.equal(skill.content, content); }
});

test('short catalogs omit skill bodies and schemas; scoped loads return exact immutable details and hashes', async () => {
  const skillId = randomUUID(), messageId = randomUUID();
  const content = '---\nactivation: on_demand\ndescription: Parcel status\n---\nPrivate domain procedure.';
  const tool = { integrationId: 'shipping', name: 'lookup', description: 'Read the current customer shipment.', inputSchema: { type: 'object' as const, properties: { reference: { type: 'string' as const, maxLength: 80 } }, required: ['reference'], additionalProperties: false as const } };
  const access = createSupportContextAccess({ skills: [{ id: skillId, name: 'shipping', revision: 3, content }], tools: [tool], messages: [{ id: messageId, role: 'customer', body: 'Original customer wording.' }], assertActive: async () => undefined });
  assert.doesNotMatch(JSON.stringify(access.catalog), /Private domain procedure|inputSchema|maxLength|Original customer wording/);
  const details = await access.load({ skillIds: [skillId], toolRefs: [{ integrationId: 'shipping', name: 'lookup' }], messageIds: [messageId] });
  assert.equal(details.skills[0]!.content, 'Private domain procedure.');
  assert.match(details.skills[0]!.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(details.tools[0]!.inputSchema, tool.inputSchema);
  Reflect.set(details.tools[0]!.inputSchema, 'type', 'tampered');
  assert.equal((await access.load({ toolRefs: [{ integrationId: 'shipping', name: 'lookup' }] })).tools[0]!.inputSchema.type, 'object');
  await assert.rejects(access.load({ skillIds: [skillId], messageIds: ['foreign-case-message'] }), /context is unavailable/);
  await assert.rejects(access.load({ skillIds: [skillId, skillId] }), /context is unavailable/);
});

test('context loading fences revocation and rejects oversized or arbitrary selectors', async () => {
  let checks = 0;
  const skill = { id: randomUUID(), name: 'core', revision: 1, content: 'x'.repeat(70000) };
  const input = { skills: [skill], tools: [], messages: [], assertActive: async () => { checks++; } };
  await assert.rejects(createSupportContextAccess(input).load({ skillIds: [skill.id] }), /context is unavailable/);
  const fenced = createSupportContextAccess({ ...input, skills: [{ ...skill, content: 'short' }], assertActive: async () => { if (++checks > 2) throw Error('revoked'); } });
  await assert.rejects(fenced.load({ skillIds: [skill.id] }), /revoked/);
  await assert.rejects(createSupportContextAccess(input).load({ skillIds: [skill.id], url: 'https://example.test' } as never), /context is unavailable/);
});

const request = (id: string, number: number, lifecycle: CustomerRequest['lifecycle']): CustomerRequest => ({
  id, number, revision: 2, title: 'Goal ' + number, goal: 'Customer goal ' + number, lifecycle, waitingOn: null, nextStep: null,
  sourceMessageIds: ['m1'], dependencyIds: [], actions: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'agent', fulfillment: null,
});
const proposal = (id: string, status: Proposal['status']): Proposal => ({
  id, caseId: 'case', tool: 'external_action', args: {}, argsHash: 'a'.repeat(64), risk: 'high', status,
  policy: { allowed: true, requiresApproval: true, checks: [] }, decidedBy: null, decidedAt: null, result: null, error: null, createdAt: '2026-01-01T00:00:00Z',
});

test('ticket memory deduplicates by ID, excludes future/current duplicates and preserves every goal and uncertain action', () => {
  const messages: ContextMessage[] = Array.from({ length: 20 }, (_, index) => ({ id: 'm' + (index + 1), role: index % 2 ? 'assistant' : 'customer', body: 'Repeated wording' }));
  messages.push({ id: 'current', role: 'customer', body: 'New goal' }, { id: 'future', role: 'customer', body: 'Must not enter this turn' });
  const catalog = emptyCatalog(); catalog.lastSourceMessageId = 'm17'; catalog.version = 3;
  const open = request('open', 1, 'open'), fulfilled = request('closed', 2, 'fulfilled'), cancelled = request('cancelled', 3, 'cancelled');
  open.dependencyIds = [fulfilled.id]; open.actions = [{ proposalId: 'uncertain', requestRevision: 1 }];
  catalog.requests = [open, fulfilled, cancelled];
  const memory = buildSupportContextMemory({ currentMessageId: 'current', messages: [messages[0]!, ...messages], requestCatalog: catalog, proposals: [proposal('uncertain', 'unknown'), proposal('working', 'executing'), proposal('approved', 'approved'), proposal('done', 'executed')] });
  assert.deepEqual(memory.requestCatalog.requests.map(row => row.id), ['open', 'closed', 'cancelled']);
  assert.deepEqual(memory.actions.map(row => row.id), ['uncertain', 'working', 'approved']);
  assert.deepEqual(memory.actions[0]!.requestIds, ['open']);
  assert.deepEqual(memory.facts.map(row => row.actionId), ['done']);
  assert.equal(memory.recentMessages.some(row => row.id === 'current' || row.id === 'future'), false);
  assert.equal(new Set(memory.recentMessages.map(row => row.id)).size, memory.recentMessages.length);
  assert.ok(memory.recentMessages.filter(row => row.body === 'Repeated wording').length > 1, 'distinct messages with identical wording remain distinct');
  assert.equal(memory.sourceCoverage.olderMessagesAvailable, true);
});

test('uncheckpointed customer goals survive the recent-message window and required oversized state is refused explicitly', () => {
  const messages: ContextMessage[] = Array.from({ length: 35 }, (_, index) => ({ id: 'c' + index, role: 'customer', body: 'Goal ' + index }));
  const memory = buildSupportContextMemory({ currentMessageId: 'c34', messages, requestCatalog: emptyCatalog(), proposals: [], recentMessageLimit: 3 });
  assert.equal(memory.recentMessages.length, 34); assert.equal(memory.sourceCoverage.uncheckpointedMessageIds.length, 35);
  assert.throws(() => buildSupportContextMemory({ currentMessageId: 'c34', messages: messages.map(row => ({ ...row, body: 'x'.repeat(5000) })), requestCatalog: emptyCatalog(), proposals: [] }), /context is unavailable/);
  assert.throws(() => buildSupportContextMemory({ currentMessageId: 'missing', messages, requestCatalog: emptyCatalog(), proposals: [] }), /context is unavailable/);
  assert.throws(() => buildSupportContextMemory({ currentMessageId: 'c34', messages: [messages[0]!, { ...messages[0]!, body: 'Conflicting source' }, ...messages.slice(1)], requestCatalog: emptyCatalog(), proposals: [] }), /context is unavailable/);
});
