import type { CaseDetail, Proposal } from '../lib/api'

const time = '2026-11-04T12:00:00.000Z'
export function proposal(id: string = 'delivery', input: Record<string, unknown> = {}): Proposal {
  return { id: 'action-synthetic', caseId: 'case-synthetic', tool: 'external_action', args: { tags: [`eldhall.ui.${id}`], input }, argsHash: 'a'.repeat(64), status: 'pending', risk: 'high', policy: { allowed: true, requiresApproval: true, checks: [] }, createdAt: time, decidedAt: null, decidedBy: null, result: null, error: null }
}
export function detail(current: Proposal): CaseDetail {
  return { case: { id: current.caseId, businessId: 'business-synthetic', customerId: 'customer-synthetic', customerName: 'Original customer', status: 'open', priority: 'P2', intent: null, analysis: null, createdAt: time, updatedAt: time }, customer: { id: 'customer-synthetic', businessId: 'business-synthetic', name: 'Original customer', email: 'synthetic@example.test', plan: 'Original plan' }, messages: [], proposals: [current], payments: [], refunds: [], audit: [], runs: [] }
}
