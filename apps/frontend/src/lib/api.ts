import { translateMessage, formatMoney, formatDateTime, type AppMessageKey, type Locale, type Translate, type TranslationValues, type UiMessage } from '../i18n'
import { captureOperatorUnauthorized } from './operator-session'
import { validRequestCatalog, type RequestCatalog } from './request-catalog'
import { validAgentActivity, type AgentActivity } from './banking'

export type CaseStatus = 'open' | 'awaiting_approval' | 'escalated' | 'resolved'
export type ProposalStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'rejected' | 'failed' | 'denied' | 'unknown' | 'expired' | 'invalidated'
export interface TicketClassification {
  classId: string; label: string; confidence: number; reason: string; revision: number; needsReview: boolean
  source: 'llm' | 'fallback'; reasonCode: 'classified' | 'low_confidence' | 'unknown_class' | 'missing_classification' | 'invalid_classification' | 'model_fallback'
  provider?: string; model?: string
  scoreKind?: 'model_self_report' | 'selected_probability'; proposedClassId?: string; proposedLabel?: string
}
export interface ClassificationConfig {
  revision: number; fallbackClassId: string; minimumConfidence: number
  classes: { id: string; label: string; description: string; examples: string[] }[]
}
export interface Analysis {
  intent: string; summary: string; reasoning: string; priority: string; tone: string; source: string; model: string
  sentiment: { label: string; frustration: number; escalationRisk: number; signals: string[]; urgency: string }
  classification?: TicketClassification | null
}
export interface SupportCase { id: string; businessId: string; customerId: string; customerName: string; status: CaseStatus; priority: string; intent: string | null; analysis: Analysis | null; ownership?: 'bot' | 'staff'; ownershipVersion?: number; assignedTo?: string | null; createdAt: string; updatedAt: string }
export interface Message { id: string; caseId: string; role: 'customer' | 'assistant' | 'operator' | 'system'; body: string; createdAt: string }
export interface Proposal { id: string; caseId: string; tool: string; args: Record<string, unknown>; argsHash: string; risk: string; status: ProposalStatus; policy: { allowed: boolean; requiresApproval: boolean; checks: { name: string; passed: boolean; detail: string }[] }; authorizationOrigin?: 'policy_auto' | 'operator_approval' | null; decidedBy: string | null; decidedAt: string | null; result: Record<string, unknown> | null; error: string | null; createdAt: string }
export interface CaseDetail {
  agentActivity?: AgentActivity
  requestCatalog?: RequestCatalog
  activeRun?: { id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' } | null
  case: SupportCase; customer: { id: string; name: string; email: string; plan: string; businessId: string }
  messages: Message[]; proposals: Proposal[]
  payments: { id: string; amountCents: number; currency: string; description: string; merchantRef: string; status: string; createdAt: string }[]
  refunds: { id: string; amountCents: number; paymentId: string; providerRef: string; simulated: boolean; createdAt: string }[]
  audit: { id: string; type: string; actor: string; data: Record<string, unknown>; createdAt: string }[]
  runs: { id: string; provider: string; model: string; status: string; steps: number; toolCalls: string[]; latencyMs: number; error: string | null; createdAt: string }[]
}
export interface Metrics { cases: number; byStatus: Record<CaseStatus, number>; byPriority: Record<string, number>; proposals: Record<ProposalStatus, number>; refundsIssuedCents: number; agentRuns: number; fallbackRuns: number; avgAgentLatencyMs: number | null }
export interface Persona { name: string; plan: string; sessionToken: string; businessName: string }
export interface CustomerRun { id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' }
export interface CustomerCase { id: string; status: CaseStatus; businessName: string; ownership?: 'bot' | 'staff'; messages: Message[]; activeRun?: CustomerRun | null }
export interface CustomerMessageResult { caseId: string; status: CaseStatus; ownership?: 'bot' | 'staff'; reply: Message | null; runId?: string | null }
export class UiError extends Error {
  readonly key: AppMessageKey
  readonly values?: TranslationValues
  constructor(key: AppMessageKey, values?: TranslationValues) {
    super(translateMessage({ key, values }, 'en'))
    this.name = 'UiError'; this.key = key; this.values = values
  }
}
function httpMessage(status: number, payload?: unknown): UiMessage {
  const proposal = record(payload) && record(payload.proposal) ? payload.proposal : undefined
  if (status === 502 && proposal?.status === 'unknown') return { key: 'core.error.executionUnknown' }
  if (status === 502 && proposal?.status === 'failed') return { key: 'core.error.executionFailed' }
  const keys: Partial<Record<number, AppMessageKey>> = { 401: 'core.error.invalidOperator', 403: 'core.error.forbidden', 404: 'core.error.notFound', 409: 'core.error.conflict', 422: 'core.error.invalidInput', 429: 'core.error.rateLimited', 500: 'core.error.serviceUnavailable', 502: 'core.error.serviceUnavailable', 503: 'core.error.serviceUnavailable' }
  return status === 200 ? { key: 'core.error.invalidResponse' } : { key: keys[status] ?? 'core.error.http', values: { status } }
}
export class ApiError extends Error {
  readonly status: number
  readonly payload: unknown
  readonly uiMessage: UiMessage
  readonly originalDetail?: string
  constructor(status: number, message: string, payload?: unknown, uiMessage?: UiMessage, originalDetail?: string) {
    super(status === 401 ? translateMessage(uiMessage ?? httpMessage(status, payload), 'en') : message); this.name = 'ApiError'; this.status = status; this.payload = payload
    this.uiMessage = uiMessage ?? httpMessage(status, payload)
    this.originalDetail = status === 401 ? undefined : originalDetail
  }
}
export function readSession(key: string) { try { return sessionStorage.getItem(key) ?? '' } catch { return '' } }
export function saveSession(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key) } catch { /* Storage may be disabled; the in-memory session still works. */ } }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const list = (value: unknown, guard: (item: unknown) => boolean) => Array.isArray(value) && value.every(guard)
const messageShape = (value: unknown) => record(value) && strings(value, ['id', 'body', 'createdAt', 'role']) && !Number.isNaN(Date.parse(String(value.createdAt)))
const customerRunShape = (value: unknown) => value === null || value === undefined || (record(value) && typeof value.id === 'string' && value.id.length > 0 && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status)))
const ownershipShape = (value: unknown) => value === undefined || value === 'bot' || value === 'staff'
const classificationShape = (value: unknown) => value === undefined || value === null || (record(value) && strings(value, ['classId', 'label', 'reason']) && typeof value.classId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.classId) && typeof value.label === 'string' && value.label.length > 0 && finite(value.confidence) && Number(value.confidence) <= 1 && Number.isInteger(value.revision) && Number(value.revision) > 0 && typeof value.needsReview === 'boolean' && ['llm', 'fallback'].includes(String(value.source)) && ['classified', 'low_confidence', 'unknown_class', 'missing_classification', 'invalid_classification', 'model_fallback'].includes(String(value.reasonCode)) && (value.provider === undefined || typeof value.provider === 'string') && (value.model === undefined || typeof value.model === 'string') && (value.scoreKind === undefined || ['model_self_report', 'selected_probability'].includes(String(value.scoreKind))) && ((value.proposedClassId === undefined && value.proposedLabel === undefined) || (typeof value.proposedClassId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.proposedClassId) && typeof value.proposedLabel === 'string' && value.proposedLabel.length > 0)))
function classificationConfigShape(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!record(value) || !Number.isInteger(value.revision) || Number(value.revision) <= 0 || !finite(value.minimumConfidence) || Number(value.minimumConfidence) > 1 || typeof value.fallbackClassId !== 'string') return false
  if (!Array.isArray(value.classes) || value.classes.length < 2 || value.classes.length > 50 || !value.classes.every(item => record(item) && strings(item, ['id', 'label', 'description']) && list(item.examples, example => typeof example === 'string'))) return false
  const ids = value.classes.map(item => String((item as Record<string, unknown>).id))
  return new Set(ids).size === ids.length && ids.includes(value.fallbackClassId)
}
const customerMessageShape = (value: unknown) => record(value) && strings(value, ['caseId', 'status']) && ownershipShape(value.ownership) && (value.reply === null || messageShape(value.reply)) && (value.runId === undefined || value.runId === null || typeof value.runId === 'string')
function caseShape(value: unknown): boolean {
  if (!record(value) || !strings(value, ['id', 'customerName', 'status', 'priority', 'updatedAt'])) return false
  if (!['open', 'awaiting_approval', 'escalated', 'resolved'].includes(String(value.status)) || Number.isNaN(Date.parse(String(value.updatedAt)))) return false
  const analysis = value.analysis
  return analysis === null || (record(analysis) && strings(analysis, ['summary', 'reasoning', 'source', 'model']) && record(analysis.sentiment) && list(analysis.sentiment.signals, item => typeof item === 'string') && classificationShape(analysis.classification))
}
function proposalShape(value: unknown): boolean { return record(value) && strings(value, ['id', 'tool', 'status', 'argsHash']) && record(value.args) && record(value.policy) && list(value.policy.checks, item => record(item) && strings(item, ['name', 'detail']) && typeof item.passed === 'boolean') }
function validPayload(path: string, value: unknown): boolean {
  const route = path.split('?')[0] ?? path
  if (route === '/operator/session') return record(value) && value.authenticated === true
  if (route === '/workspace') return record(value) && record(value.business) && strings(value.business, ['id', 'slug', 'name', 'currency']) && String(value.business.id).trim().length > 0 && String(value.business.slug).trim().length > 0 && String(value.business.name).trim().length > 0 && /^[A-Z]{3}$/.test(String(value.business.currency))
  if (route === '/cases') return list(value, caseShape)
  if (/^\/cases\/[^/]+$/.test(route)) return record(value) && caseShape(value.case) && record(value.customer) && strings(value.customer, ['name', 'email', 'plan']) && list(value.messages, messageShape) && list(value.proposals, proposalShape) && list(value.payments, item => record(item) && strings(item, ['id', 'currency', 'createdAt', 'description', 'status']) && finite(item.amountCents)) && list(value.refunds, item => record(item) && strings(item, ['id', 'providerRef'])) && list(value.audit, item => record(item) && strings(item, ['id', 'type', 'actor', 'createdAt'])) && list(value.runs, item => record(item) && strings(item, ['id', 'status', 'provider', 'model']) && finite(item.latencyMs) && list(item.toolCalls, tool => typeof tool === 'string')) && customerRunShape(value.activeRun) && validRequestCatalog(value.requestCatalog, value as unknown as CaseDetail) && validAgentActivity(value.agentActivity, value as unknown as CaseDetail)
  if (route === '/metrics') return record(value) && finite(value.cases) && record(value.byStatus) && ['open', 'awaiting_approval', 'escalated', 'resolved'].every(key => finite((value.byStatus as Record<string, unknown>)[key])) && record(value.byPriority) && record(value.proposals) && Object.values(value.proposals).every(finite) && finite(value.agentRuns) && finite(value.fallbackRuns) && (value.avgAgentLatencyMs === null || finite(value.avgAgentLatencyMs))
  if (route === '/chat/personas') return list(value, item => record(item) && strings(item, ['name', 'sessionToken', 'businessName', 'plan']))
  if (/^\/chat\/cases\/[^/]+$/.test(route)) return record(value) && strings(value, ['id', 'status', 'businessName']) && ownershipShape(value.ownership) && customerRunShape(value.activeRun) && list(value.messages, messageShape)
  if (route === '/businesses') return record(value) && list(value.businesses, item => record(item) && strings(item, ['id', 'name', 'currency']))
  if (route === '/knowledge') return record(value) && record(value.capabilities) && list(value.sources, item => record(item) && strings(item, ['id', 'businessId', 'title', 'category', 'content', 'status', 'updatedAt']) && finite(item.version))
  if (route === '/team') return record(value) && record(value.capabilities) && list(value.members, item => record(item) && strings(item, ['id', 'name', 'role']) && finite(item.assignedCases))
  if (route === '/settings') return record(value) && strings(value, ['businessId', 'language', 'tone']) && finite(value.version) && finite(value.refundLimitCents) && finite(value.duplicateWindowMinutes) && list(value.enabledTools, item => typeof item === 'string') && classificationConfigShape(value.classification)
  if (route === '/skills') return record(value) && typeof value.preset === 'string' && list(value.skills, item => record(item) && strings(item, ['id', 'name', 'content', 'updatedAt']) && finite(item.revision) && typeof item.enabled === 'boolean')
  if (route === '/capabilities') return record(value) && strings(value, ['runtime', 'provider', 'model', 'persistence', 'paymentProvider', 'knowledgeSearch']) && typeof value.credentialsConfigured === 'boolean' && finite(value.maxToolCalls)
  return record(value) || Array.isArray(value)
}
export async function request<T>(path: string, token = '', options: { method?: string; body?: unknown; signal?: AbortSignal; customer?: boolean } = {}): Promise<T> {
  const unauthorized = captureOperatorUnauthorized(token, options.customer)
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = window.setTimeout(abort, options.method ? 60_000 : 15_000)
  try {
    const response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET', signal: controller.signal, cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? options.customer ? { 'X-Customer-Session': token } : { Authorization: `Bearer ${token}` } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
    if (response.status === 401) unauthorized?.()
    let payload: unknown
    try { payload = await response.json() } catch { throw new ApiError(response.status, '', undefined, { key: 'core.error.unexpectedResponse' }) }
    if (!response.ok) {
      const original = record(payload) && typeof payload.detail === 'string' ? payload.detail : record(payload) && record(payload.proposal) && typeof payload.proposal.error === 'string' ? payload.proposal.error : undefined
      const uiMessage = response.status === 401 && options.customer ? { key: 'core.error.invalidCustomer' as const } : httpMessage(response.status, payload)
      throw new ApiError(response.status, original ?? '', payload, uiMessage, original)
    }
    const valid = options.method === 'POST' && /^\/chat\/cases\/[^/]+\/messages$/.test(path)
      ? customerMessageShape(payload)
      : options.method ? record(payload) || Array.isArray(payload) : validPayload(path, payload)
    if (!valid) throw new ApiError(response.status, '', undefined, { key: 'core.error.invalidResponse' })
    return payload as T
  } catch (error) {
    if (error instanceof ApiError || error instanceof UiError) throw error
    throw new UiError(controller.signal.aborted ? 'core.error.timeout' : 'core.error.network')
  } finally { window.clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}
export function errorText(error: unknown, t: Translate): string {
  if (error instanceof UiError) return t(error.key, error.values)
  if (error instanceof ApiError) return t(error.uiMessage.key, error.uiMessage.values)
  return t('core.error.request')
}
export function money(cents: number, currency: string, locale: Locale = 'en') { return formatMoney(cents, currency, locale) }
export function dateTime(date: string, locale: Locale = 'en') { return formatDateTime(date, locale) }
export const caseLabels: Record<CaseStatus, AppMessageKey> = { open: 'core.status.open', awaiting_approval: 'core.status.awaiting_approval', escalated: 'core.status.escalated', resolved: 'core.status.resolved' }
export const proposalLabels: Record<ProposalStatus, AppMessageKey> = { pending: 'core.status.awaiting_approval', approved: 'core.status.approved', executing: 'core.status.executing', executed: 'core.status.executed', rejected: 'core.status.rejected', failed: 'core.status.failed', denied: 'core.status.denied', unknown: 'core.status.unknown', expired: 'core.status.expired', invalidated: 'core.status.invalidated' }
export const intentLabels: Record<string, AppMessageKey> = { duplicate_charge: 'core.intent.duplicate_charge', refund_request: 'core.intent.refund_request', billing_question: 'core.intent.billing_question', cancel_subscription: 'core.intent.cancel_subscription', complaint: 'core.intent.complaint', other: 'core.intent.other' }
export const toolLabels: Record<string, AppMessageKey> = { refund_payment: 'core.tool.refund_payment', escalate_to_human: 'core.tool.escalate_to_human', lookup_payments: 'core.tool.lookup_payments' }
export function toolLabel(tool: string, t: Translate) { const key = toolLabels[tool]; return key ? t(key) : tool }
export function intentLabel(intent: string, t: Translate) { const key = intentLabels[intent]; return key ? t(key) : intent }
