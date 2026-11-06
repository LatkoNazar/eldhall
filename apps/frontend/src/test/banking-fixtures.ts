import type { GuardConfiguration, Skill } from '../lib/banking'
import { uuid } from './request-fixtures'

export const workspaceBusiness = { id: uuid(101), slug: 'fixture-bank', name: 'Fixture Bank', currency: 'UAH' }
export const bankingTime = '2026-11-06T10:00:00.000Z'
export function skillFixture(): Skill { return { id: uuid(601), businessId: workspaceBusiness.id, name: 'custom/customer-support', content: 'Use recorded customer facts.', revision: 1, enabled: true, updatedAt: bankingTime } }
export function guardFixture(): GuardConfiguration {
  return { version: 1, revision: 0, rules: [], definitions: [
    { kind: 'deny_action', definitionVersion: 1, title: 'Deny an action', description: 'Extra restriction', targetTools: ['refund_payment', 'external_action'] },
    { kind: 'require_approval', definitionVersion: 1, title: 'Require approval', description: 'Extra restriction', targetTools: ['refund_payment', 'external_action'] },
    { kind: 'amount_limit', definitionVersion: 1, title: 'Refund ceiling', description: 'Extra restriction', targetTools: ['refund_payment'] },
  ] }
}
