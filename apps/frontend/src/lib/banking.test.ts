import { expect, it } from 'vitest'
import { guardFixture, bankingTime, skillFixture, workspaceBusiness } from '../test/banking-fixtures'
import { requestFixture, uuid } from '../test/request-fixtures'
import { validAgentActivity, validGuard, validGuardConfiguration, validSkill, type AgentActivity } from './banking'

it('preserves a valid101-skill context and the200-character names allowed by code configuration', () => {
  const detail = requestFixture()
  const name = 'universal/' + 'a'.repeat(190)
  expect(name).toHaveLength(200)
  expect(validSkill({ ...skillFixture(), name }, workspaceBusiness.id)).toBe(true)
  expect(validSkill({ ...skillFixture(), name: name + 'a' }, workspaceBusiness.id)).toBe(false)
  const skills = Array.from({ length: 101 }, (_, index) => ({ id: uuid(1000 + index), name: index === 100 ? name : `universal/skill-${index}`, revision: 1, contentHash: 'a'.repeat(64), preview: 'abc', truncated: false, loadedCharacters: 3, totalCharacters: 3 }))
  const activity: AgentActivity = { status: 'recorded', hasMore: false, events: [{ id: uuid(701), runId: uuid(710), sequence: 1, turnJobId: uuid(711), callId: null, createdAt: bankingTime, type: 'context', tool: null, outcome: 'succeeded', summary: 'Recorded complete skill context.', reason: null, proposalId: null, requestIds: [], input: null, result: null, checks: [], context: { settingsVersion: 1, guardRevision: 0, skills, guards: [], provider: 'rules', model: 'fixture' } }] }
  expect(validAgentActivity(activity, detail)).toBe(true)
  expect(activity.events[0]!.context!.skills).toHaveLength(101)
  expect(activity.events[0]!.context!.skills[100]!.name).toBe(name)
  activity.events[0]!.context!.skills[100]!.contentHash = 'invalid'
  expect(validAgentActivity(activity, detail)).toBe(false)
})

it('accepts only the fixed registered guard profile without arbitrary predicates, invalid amounts or mismatched targets', () => {
  expect(validGuardConfiguration(guardFixture())).toBe(true)
  const base = { id: uuid(801), name: 'Refund ceiling', reason: 'Reviewed limit', kind: 'amount_limit', definitionVersion: 1, enabled: true, target: { tool: 'refund_payment' }, maxAmountCents: 25000, currency: 'UAH' }
  expect(validGuard(base)).toBe(true)
  for (const change of [{ definitionVersion: 2 }, { kind: 'javascript' }, { predicate: 'return true' }, { maxAmountCents: -1 }, { maxAmountCents: 1.2 }, { currency: 'usd' }, { target: { tool: 'external_action' } }, { target: { tool: 'refund_payment', integrationId: 'bank' } }, { reason: '' }]) expect(validGuard({ ...base, ...change })).toBe(false)
  const config = guardFixture(); config.rules = [base, base] as typeof config.rules
  expect(validGuardConfiguration(config)).toBe(false)
})

it('rejects malformed, cross-request/proposal and unbounded activity before rendering, preserving honest legacy absence', () => {
  const detail = requestFixture()
  const source: AgentActivity = { status: 'recorded', hasMore: false, events: [{ id: uuid(701), runId: uuid(710), sequence: 1, turnJobId: uuid(711), callId: 'call-1', createdAt: bankingTime, type: 'tool_result', tool: 'lookup_payments', outcome: 'succeeded', summary: 'One payment recorded.', reason: null, proposalId: uuid(301), requestIds: [uuid(3)], input: { limit: 10 }, result: { paymentCount: 1 }, checks: [], context: null }] }
  expect(validAgentActivity(source, detail)).toBe(true)
  expect(validAgentActivity(undefined, detail)).toBe(true)
  for (const change of [{ proposalId: uuid(999) }, { requestIds: [uuid(999)] }, { sequence: 0 }, { type: 'raw_sdk_event' }, { outcome: 'paid_successfully' }, { input: { nested: { raw: 'not a public fact' } } }, { result: { unbounded: 'x'.repeat(4001) } }, { createdAt: 'invalid' }]) expect(validAgentActivity({ ...source, events: [{ ...source.events[0], ...change }] }, detail)).toBe(false)
  expect(validAgentActivity({ ...source, events: [source.events[0], source.events[0]] }, detail)).toBe(false)
  expect(validAgentActivity({ ...source, status: 'not_recorded' }, detail)).toBe(false)
  const context = { settingsVersion: 1, guardRevision: 2, provider: 'rules', model: 'fixture', guards: [], skills: [{ id: uuid(601), name: 'custom/support', revision: 2, contentHash: 'a'.repeat(64), preview: 'A'.repeat(240), truncated: true, loadedCharacters: 8000, totalCharacters: 9000 }] }
  const withContext = (change: Record<string, unknown>) => ({ ...source, events: [{ ...source.events[0], context: { ...context, ...change } }] })
  expect(validAgentActivity(withContext({}), detail)).toBe(true)
  expect(validAgentActivity(withContext({ guardRevision: -1 }), detail)).toBe(false)
  expect(validAgentActivity(withContext({ skills: [{ ...context.skills[0], contentHash: 'not-a-hash' }] }), detail)).toBe(false)
  expect(validAgentActivity(withContext({ skills: [{ ...context.skills[0], loadedCharacters: 9000 }] }), detail)).toBe(false)
  expect(validAgentActivity(withContext({ skills: [{ ...context.skills[0], preview: 'Incomplete but not described as such' }] }), detail)).toBe(false)
})
