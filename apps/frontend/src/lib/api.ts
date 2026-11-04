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
export class ApiError extends Error {
  status: number
  payload: unknown
  constructor(status: number, message: string, payload?: unknown) { super(message); this.status = status; this.payload = payload }
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
  if (route === '/cases') return list(value, caseShape)
  if (/^\/cases\/[^/]+$/.test(route)) return record(value) && caseShape(value.case) && record(value.customer) && strings(value.customer, ['name', 'email', 'plan']) && list(value.messages, messageShape) && list(value.proposals, proposalShape) && list(value.payments, item => record(item) && strings(item, ['id', 'currency', 'createdAt', 'description', 'status']) && finite(item.amountCents)) && list(value.refunds, item => record(item) && strings(item, ['id', 'providerRef'])) && list(value.audit, item => record(item) && strings(item, ['id', 'type', 'actor', 'createdAt'])) && list(value.runs, item => record(item) && strings(item, ['id', 'status', 'provider', 'model']) && finite(item.latencyMs) && Array.isArray(item.toolCalls))
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
    let payload: unknown
    try { payload = await response.json() } catch { throw new ApiError(response.status, 'Сервер повернув неочікувану відповідь.') }
    if (!response.ok) {
      const detail = record(payload) && typeof payload.detail === 'string' ? payload.detail : record(payload) && record(payload.proposal) && typeof payload.proposal.error === 'string' ? payload.proposal.error : response.status === 401 ? 'Ключ доступу недійсний або сесію завершено.' : response.status === 403 ? 'Для цієї дії немає дозволу.' : response.status === 404 ? 'Ресурс недоступний у цьому середовищі.' : `Запит не виконано (${response.status}).`
      throw new ApiError(response.status, detail, payload)
    }
    const valid = options.method === 'POST' && /^\/chat\/cases\/[^/]+\/messages$/.test(path)
      ? customerMessageShape(payload)
      : options.method ? record(payload) || Array.isArray(payload) : validPayload(path, payload)
    if (!valid) throw new ApiError(response.status, 'Некоректна структура відповіді сервера.')
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new Error(controller.signal.aborted ? 'Час очікування минув. Оновіть дані, щоб перевірити фактичний стан.' : 'Немає з’єднання із сервером. Спробуйте оновити дані.', { cause: error })
  } finally { window.clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : 'Не вдалося виконати запит.' }
export function money(cents: number, currency: string) { return new Intl.NumberFormat('uk-UA', { style: 'currency', currency }).format(cents / 100) }
export function dateTime(date: string) { return new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Kyiv' }).format(new Date(date)) }
export const caseLabels: Record<CaseStatus, string> = { open: 'Відкрите', awaiting_approval: 'Очікує погодження', escalated: 'Потребує оператора', resolved: 'Вирішене' }
export const proposalLabels: Record<ProposalStatus, string> = { pending: 'Очікує погодження', approved: 'Погоджено, очікує виконання', executing: 'Виконується', executed: 'Виконано', rejected: 'Відхилено', failed: 'Не виконано', denied: 'Дію не дозволено', unknown: 'Результат уточнюється', expired: 'Строк погодження минув', invalidated: 'Погодження втратило чинність' }
export const intentLabels: Record<string, string> = { duplicate_charge: 'Подвійне списання', refund_request: 'Запит на повернення', billing_question: 'Питання про оплату', cancel_subscription: 'Скасування підписки', complaint: 'Скарга', other: 'Інше звернення' }
export const toolLabels: Record<string, string> = { refund_payment: 'Повернення платежу', escalate_to_human: 'Передавання оператору', lookup_payments: 'Перевірка платежів' }
