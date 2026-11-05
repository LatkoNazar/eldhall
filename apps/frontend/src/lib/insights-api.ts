import { ApiError, request } from './api'

export interface InsightSample {
  caseCount: number; messageCount: number; knowledgeCount: number; totalCases: number; totalPublishedKnowledge: number
  truncated: boolean; from: string | null; to: string | null
}
export interface InsightFinding {
  id: string; kind: 'recurring_issue' | 'knowledge_gap' | 'possible_contradiction'
  title: string; summary: string; recommendation: string; caseCount: number
  evidence: { caseId: string; messageIds: string[] }[]; knowledgeRefs: { id: string; version: number }[]
  proposedArticle: { title: string; content: string } | null; draftId: string | null
}
export interface InsightRun {
  id: string; businessId: string; status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: string; completedAt: string | null; provider: string; model: string
  sample: InsightSample; findings: InsightFinding[]; error: string | null; stale: boolean
}
export interface InsightDraft { id: string; businessId: string; title: string; content: string; status: 'draft'; version: number }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum
const id = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const date = (value: unknown) => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
const nullableText = (value: unknown, maximum: number) => value === null || text(value, maximum)
function sampleShape(value: unknown): boolean {
  return record(value) && ['caseCount', 'messageCount', 'knowledgeCount', 'totalCases', 'totalPublishedKnowledge'].every(key => count(value[key])) && Number(value.caseCount) <= Number(value.totalCases) && Number(value.knowledgeCount) <= Number(value.totalPublishedKnowledge) && typeof value.truncated === 'boolean' && date(value.from) && date(value.to)
}
function findingShape(value: unknown): boolean {
  if (!record(value) || !id(value.id) || !['recurring_issue', 'knowledge_gap', 'possible_contradiction'].includes(String(value.kind)) || !text(value.title, 160) || !text(value.summary, 1200) || !text(value.recommendation, 800) || !count(value.caseCount) || Number(value.caseCount) < 1 || !(value.draftId === null || id(value.draftId))) return false
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 25 || !value.evidence.every(item => record(item) && id(item.caseId) && Array.isArray(item.messageIds) && item.messageIds.length > 0 && item.messageIds.length <= 8 && item.messageIds.every(id))) return false
  if (new Set(value.evidence.map(item => String((item as Record<string, unknown>).caseId))).size !== value.caseCount) return false
  if (!Array.isArray(value.knowledgeRefs) || value.knowledgeRefs.length > 20 || !value.knowledgeRefs.every(item => record(item) && id(item.id) && count(item.version) && Number(item.version) > 0)) return false
  return value.proposedArticle === null || (record(value.proposedArticle) && text(value.proposedArticle.title, 200) && text(value.proposedArticle.content, 6000))
}
function parseRun(value: unknown, businessId: string): InsightRun {
  if (!record(value) || !id(value.id) || value.businessId !== businessId || !['queued', 'running', 'completed', 'failed'].includes(String(value.status)) || !date(value.createdAt) || value.createdAt === null || !date(value.completedAt) || !text(value.provider, 200) || !text(value.model, 200) || !sampleShape(value.sample) || !Array.isArray(value.findings) || value.findings.length > 8 || !value.findings.every(findingShape) || !nullableText(value.error, 4000) || typeof value.stale !== 'boolean' || (value.stale && value.findings.length > 0)) throw new ApiError(200, '', undefined, { key: 'core.error.invalidResponse' })
  return value as unknown as InsightRun
}
const scope = (businessId: string) => `businessId=${encodeURIComponent(businessId)}`
export async function listInsightRuns(businessId: string, token: string, signal?: AbortSignal): Promise<InsightRun[]> {
  const payload = await request<unknown>(`/insights/runs?${scope(businessId)}`, token, { signal })
  if (!record(payload) || !Array.isArray(payload.runs)) throw new ApiError(200, '', undefined, { key: 'core.error.invalidResponse' })
  return payload.runs.map(run => parseRun(run, businessId))
}
export async function getInsightRun(businessId: string, runId: string, token: string, signal?: AbortSignal): Promise<InsightRun> {
  return parseRun(await request<unknown>(`/insights/runs/${encodeURIComponent(runId)}?${scope(businessId)}`, token, { signal }), businessId)
}
export async function startInsightRun(businessId: string, limit: number, clientRequestId: string, token: string, signal?: AbortSignal): Promise<InsightRun> {
  return parseRun(await request<unknown>('/insights/runs', token, { method: 'POST', body: { businessId, limit, clientRequestId }, signal }), businessId)
}
export async function createInsightDraft(businessId: string, runId: string, findingId: string, token: string, signal?: AbortSignal): Promise<InsightDraft> {
  const payload = await request<unknown>(`/insights/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/draft?${scope(businessId)}`, token, { method: 'POST', signal })
  if (!record(payload) || !record(payload.draft) || !id(payload.draft.id) || payload.draft.businessId !== businessId || payload.draft.status !== 'draft' || !text(payload.draft.title, 200) || !text(payload.draft.content, 50_000) || !count(payload.draft.version) || Number(payload.draft.version) < 1) throw new ApiError(200, '', undefined, { key: 'core.error.draftUnconfirmed' })
  return payload.draft as unknown as InsightDraft
}
