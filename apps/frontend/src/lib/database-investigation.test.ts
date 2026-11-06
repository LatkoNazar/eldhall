import { expect, it } from 'vitest'
import { databasePolicyFixture } from '../test/database-investigation-fixtures'
import { validDatabaseInvestigationPolicy, validDatabaseLimits } from './database-investigation'

it('accepts only the closed read-only/current-customer policy and declared deployment sources', () => {
  const policy = databasePolicyFixture()
  expect(validDatabaseInvestigationPolicy(policy)).toBe(true)
  expect(validDatabaseInvestigationPolicy({ ...policy, sources: [] })).toBe(true)
  for (const constraints of [{ readOnly: false, scope: 'current_customer' }, { readOnly: true, scope: 'all_customers' }, { readOnly: true }, null]) expect(validDatabaseInvestigationPolicy({ ...policy, constraints })).toBe(false)
  for (const sources of [[...policy.sources, ...policy.sources], [{ ...policy.sources[0], status: 'connected' }], [{ ...policy.sources[0], url: 'https://private.invalid' }]]) expect(validDatabaseInvestigationPolicy({ ...policy, sources })).toBe(false)
  expect(validDatabaseInvestigationPolicy({ ...policy, version: 0 })).toBe(false)
})

it('rejects excessive, fractional and missing limits and a server contract that expands the bounds', () => {
  const policy = databasePolicyFixture()
  for (const limits of [{ ...policy.limits, maxQueriesPerTurn: 13 }, { ...policy.limits, timeoutMs: 99 }, { ...policy.limits, maxRows: 1.5 }, { ...policy.limits, maxBytes: NaN }, { ...policy.limits, maxRows: undefined }, { ...policy.limits, sql: 'SELECT 1' }]) expect(validDatabaseLimits(limits)).toBe(false)
  expect(validDatabaseInvestigationPolicy({ ...policy, bounds: { ...policy.bounds, maxRows: { min: 1, max: 1000 } } })).toBe(false)
  expect(validDatabaseInvestigationPolicy({ ...policy, connectionString: 'private' })).toBe(false)
})
