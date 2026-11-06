import type { CaseDetail, Proposal } from '../lib/api'
import type { CustomerRequest, RequestCatalog } from '../lib/request-catalog'

export const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
export const requestTime = '2026-11-06T10:00:00.000Z'
export function requestFixture(): CaseDetail {
  const caseId = uuid(100)
  const request = (number: number, title: string): CustomerRequest => ({ id: uuid(number), number, revision: 1, title, goal: `Goal: ${title}`, lifecycle: 'open', waitingOn: null, nextStep: `Next: ${title}`, sourceMessageIds: [uuid(201)], dependencyIds: [], actions: [], createdAt: requestTime, updatedAt: requestTime, updatedBy: 'agent', fulfillment: null })
  const action: Proposal = { id: uuid(301), caseId, tool: 'external_action', args: { title: 'Refund duplicate charge', tags: ['eldhall.ui.payments'], input: { payment_id: uuid(401), amount_cents: 10000, currency: 'UAH' }, effect: 'write', expiresAt: '2099-01-01T00:00:00Z' }, argsHash: 'a'.repeat(64), status: 'approved', risk: 'high', policy: { allowed: true, requiresApproval: true, checks: [] }, decidedBy: 'staff', decidedAt: requestTime, createdAt: requestTime, result: null, error: null }
  const requests = [request(1, 'Change delivery address'), request(2, 'Move delivery date'), request(3, 'Refund duplicate charge'), request(4, 'Send invoice')]
  requests[0]!.waitingOn = 'customer'
  requests[1]!.dependencyIds = [uuid(1)]
  requests[2]!.waitingOn = 'staff'; requests[2]!.actions = [{ proposalId: action.id, requestRevision: 1 }]
  requests[3]!.lifecycle = 'fulfilled'; requests[3]!.sourceMessageIds = [uuid(201), uuid(204)]; requests[3]!.fulfillment = { reason: 'Customer confirmed invoice receipt', proof: { proposalIds: [], messageIds: [uuid(204)] }, actor: 'staff', at: requestTime }
  const requestCatalog: RequestCatalog = { version: 1, syncState: 'current', lastSourceMessageId: uuid(206), requests, history: { events: requests.map(item => ({ id: uuid(500 + item.number), requestId: item.id, revision: item.revision, type: 'created', actor: 'agent', at: requestTime, reason: null, snapshot: structuredClone(item) })), hasMore: false } }
  return { case: { id: caseId, businessId: uuid(101), customerId: uuid(102), customerName: 'Marta Savchuk', status: 'awaiting_approval', priority: 'P2', intent: 'other', analysis: null, ownership: 'staff', ownershipVersion: 1, assignedTo: 'staff', createdAt: requestTime, updatedAt: requestTime }, customer: { id: uuid(102), businessId: uuid(101), name: 'Marta Savchuk', email: 'marta@example.invalid', plan: 'Customer' }, requestCatalog, messages: ['Change my address, move delivery, refund the duplicate and send the invoice.', 'Please provide the new address.', 'The refund is proposed, not executed.', 'I received the invoice, thank you.', 'New address: Lisova12; I will provide the apartment later.', 'Thank you. Please send the apartment number.'].map((body, index) => ({ id: uuid(201 + index), caseId, role: index === 0 || index === 3 || index === 4 ? 'customer' as const : 'assistant' as const, body, createdAt: requestTime })), proposals: [action], payments: [{ id: uuid(401), amountCents: 10000, currency: 'UAH', description: 'Duplicate charge', merchantRef: 'ORDER-1048', status: 'captured', createdAt: requestTime }], refunds: [], audit: [], runs: [] }
}
