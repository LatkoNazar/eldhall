import type { CaseDetail } from './api'

export interface RequestActionLink { proposalId: string; requestRevision: number }
export interface RequestProof { proposalIds: string[]; messageIds: string[] }
export interface CustomerRequest {
  id: string; number: number; revision: number; title: string; goal: string
  lifecycle: 'open' | 'fulfilled' | 'cancelled'; waitingOn: 'customer' | 'staff' | null
  nextStep: string | null; sourceMessageIds: string[]; dependencyIds: string[]
  actions: RequestActionLink[]; createdAt: string; updatedAt: string; updatedBy: string
  fulfillment: { reason: string; proof: RequestProof; actor: string; at: string } | null
}
export interface RequestEvent {
  id: string; requestId: string; revision: number
  type: 'created' | 'updated' | 'sources_linked' | 'action_linked' | 'fulfilled' | 'cancelled' | 'reopened'
  actor: string; at: string; reason: string | null; snapshot: CustomerRequest
}
export interface RequestCatalog {
  version: number; syncState: 'current' | 'needs_review'; lastSourceMessageId: string | null
  requests: CustomerRequest[]; history: { events: RequestEvent[]; hasMore: boolean }
}
export type RequestTransition = 'fulfill' | 'cancel' | 'reopen'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum = 1): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)
const list = (value: unknown, guard: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.every(guard)
const ids = (value: unknown): value is string[] => list(value, uuid) && new Set(value).size === value.length
function proof(value: unknown): value is RequestProof { return record(value) && ids(value.proposalIds) && ids(value.messageIds) }
function customerRequest(value: unknown): value is CustomerRequest {
  if (!record(value) || !uuid(value.id) || !integer(value.number) || !integer(value.revision) || !text(value.title, 160) || !text(value.goal, 1200)) return false
  if (!['open', 'fulfilled', 'cancelled'].includes(String(value.lifecycle)) || !(value.waitingOn === null || value.waitingOn === 'customer' || value.waitingOn === 'staff')) return false
  if (!(value.nextStep === null || text(value.nextStep, 500)) || !ids(value.sourceMessageIds) || !value.sourceMessageIds.length || !ids(value.dependencyIds)) return false
  if (!list(value.actions, link => record(link) && uuid(link.proposalId) && integer(link.requestRevision) && Number(link.requestRevision) <= Number(value.revision))) return false
  if (new Set(value.actions.map(link => (link as RequestActionLink).proposalId)).size !== value.actions.length) return false
  if (!date(value.createdAt) || !date(value.updatedAt) || !text(value.updatedBy, 200)) return false
  return value.fulfillment === null || (record(value.fulfillment) && text(value.fulfillment.reason, 800) && proof(value.fulfillment.proof) && text(value.fulfillment.actor, 200) && date(value.fulfillment.at))
}

/** Legacy absence is allowed; a supplied catalog must have a render-safe, scoped shape. */
export function validRequestCatalog(value: unknown, detail: Pick<CaseDetail, 'case' | 'customer' | 'messages' | 'proposals'>): value is RequestCatalog | undefined {
  if (value === undefined) return true
  if (!record(value) || !integer(value.version, 0) || !['current', 'needs_review'].includes(String(value.syncState)) || !list(value.requests, customerRequest) || !record(value.history) || typeof value.history.hasMore !== 'boolean') return false
  if (typeof detail.case.customerId !== 'string' || detail.case.customerId !== detail.customer.id || typeof detail.case.businessId !== 'string' || detail.case.businessId !== detail.customer.businessId || detail.messages.some(item => item.caseId !== detail.case.id) || detail.proposals.some(item => item.caseId !== detail.case.id)) return false
  const requests = value.requests as CustomerRequest[]
  const requestIds = new Set(requests.map(item => item.id))
  if (requestIds.size !== requests.length || new Set(requests.map(item => item.number)).size !== requests.length) return false
  const messages = new Set(detail.messages.filter(item => item.caseId === detail.case.id).map(item => item.id))
  const proposals = new Set(detail.proposals.filter(item => item.caseId === detail.case.id).map(item => item.id))
  const scopedProof = (item: RequestProof) => item.messageIds.every(id => messages.has(id)) && item.proposalIds.every(id => proposals.has(id))
  const scopedRequest = (item: CustomerRequest) => item.sourceMessageIds.every(id => messages.has(id)) && item.dependencyIds.every(id => id !== item.id && requestIds.has(id)) && item.actions.every(link => proposals.has(link.proposalId)) && (!item.fulfillment || scopedProof(item.fulfillment.proof))
  if (!(value.lastSourceMessageId === null || (typeof value.lastSourceMessageId === 'string' && messages.has(value.lastSourceMessageId))) || !requests.every(scopedRequest)) return false
  return list(value.history.events, event => record(event) && uuid(event.id) && typeof event.requestId === 'string' && requestIds.has(event.requestId) && integer(event.revision) && ['created', 'updated', 'sources_linked', 'action_linked', 'fulfilled', 'cancelled', 'reopened'].includes(String(event.type)) && text(event.actor, 200) && date(event.at) && (event.reason === null || text(event.reason, 800)) && customerRequest(event.snapshot) && event.snapshot.id === event.requestId && event.snapshot.revision === event.revision && scopedRequest(event.snapshot))
}

export function requestLabel(item: CustomerRequest) { return `R-${String(item.number).padStart(2, '0')}` }
export function requestProposals(item: CustomerRequest, detail: CaseDetail) {
  const linked = new Set(item.actions.map(action => action.proposalId))
  return detail.proposals.filter(proposal => proposal.caseId === detail.case.id && linked.has(proposal.id))
}
export function currentRequestProposals(item: CustomerRequest, detail: CaseDetail) {
  const current = new Set(item.actions.filter(action => action.requestRevision === item.revision).map(action => action.proposalId))
  return requestProposals(item, detail).filter(proposal => current.has(proposal.id))
}
export function waitingDependencies(item: CustomerRequest, catalog: RequestCatalog) {
  return catalog.requests.filter(other => item.dependencyIds.includes(other.id) && other.lifecycle !== 'fulfilled')
}
export function requestNeedsVerification(item: CustomerRequest, detail: CaseDetail) {
  return requestProposals(item, detail).some(proposal => ['executing', 'unknown'].includes(proposal.status))
}
/** Any revision's unsettled effect blocks another pending action; reconciliation remains available. */
export function blockedRequestProposals(catalog: RequestCatalog | undefined, detail: CaseDetail) {
  const blocked = new Set<string>()
  for (const item of catalog?.requests ?? []) if (requestNeedsVerification(item, detail)) {
    for (const proposal of requestProposals(item, detail)) if (['pending', 'approved'].includes(proposal.status)) blocked.add(proposal.id)
  }
  return blocked
}
