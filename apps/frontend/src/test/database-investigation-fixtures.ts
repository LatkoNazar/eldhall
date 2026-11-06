import { databaseLimitBounds, type DatabaseInvestigationPolicy } from '../lib/database-investigation'

export function databasePolicyFixture(): DatabaseInvestigationPolicy {
  return { version: 1, enabled: false, limits: { maxQueriesPerTurn: 8, timeoutMs: 2000, maxRows: 100, maxBytes: 32768 }, bounds: structuredClone(databaseLimitBounds), constraints: { readOnly: true, scope: 'current_customer' }, sources: [{ id: 'bank-records', label: 'Fixture bank records', status: 'configured' }] }
}
