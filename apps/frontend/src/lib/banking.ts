import type { CaseDetail } from './api'

export interface Skill { id: string; businessId: string; name: string; content: string; revision: number; enabled: boolean; updatedAt: string }
export interface SkillDraft {
  slug: string; content: string; reviewedSkills: number; totalSkills: number
  related: { id: string; name: string; revision: number; enabled: boolean; kind: 'reuse' | 'overlap'; reason: string }[]
}
export type GuardKind = 'deny_action' | 'require_approval' | 'amount_limit'
export interface GuardRule {
  id: string; name: string; definitionVersion: 1; enabled: boolean
  target: { tool: 'refund_payment' | 'external_action'; integrationId?: string; operationKey?: string }
  reason: string; kind: GuardKind; maxAmountCents?: number; currency?: string
}
export interface GuardDefinition { kind: GuardKind; definitionVersion: 1; title: string; description: string; targetTools: ('refund_payment' | 'external_action')[] }
export interface GuardConfiguration { version: number; revision: number; rules: GuardRule[]; definitions: GuardDefinition[]; canGenerate?: boolean }
export type ActivityFacts = Record<string, string | number | boolean | null | string[]>
export interface ActivityContext {
  settingsVersion: number; guardRevision: number
  skills: { id: string; name: string; revision: number; contentHash: string; preview: string; truncated: boolean; loadedCharacters: number; totalCharacters: number }[]
  availableSkills?: { id: string; name: string; revision: number; purpose: string; activation: 'always' | 'on_demand' }[]
  guards: GuardRule[]; provider: string; model: string
}
export interface AgentActivityEvent {
  id: string; runId: string; sequence: number; turnJobId: string | null; callId: string | null; createdAt: string
  type: 'context' | 'tool_call' | 'tool_result' | 'decision' | 'fallback' | 'guard'
  tool: string | null; outcome: 'started' | 'succeeded' | 'proposed' | 'denied' | 'failed' | 'unknown' | 'fallback'
  summary: string; reason: string | null; proposalId: string | null; requestIds: string[]
  input: ActivityFacts | null; result: ActivityFacts | null
  checks: { name: string; passed: boolean; detail: string }[]
  context: ActivityContext | null
}
export interface AgentActivity { status: 'recorded' | 'not_recorded'; events: AgentActivityEvent[]; hasMore: boolean }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(item => string(item))
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)
export function validSkill(value: unknown, businessId: string): value is Skill {
  return record(value) && string(value.id) && value.businessId === businessId && string(value.name, 200) && string(value.content, 30000) && positive(value.revision) && typeof value.enabled === 'boolean' && date(value.updatedAt)
}
export function validSkillDraft(value: unknown): value is SkillDraft {
  return record(value) && string(value.slug, 64) && /^[a-z0-9][a-z0-9-]*$/.test(value.slug)
    && string(value.content, 30_000) && !!value.content.trim()
    && Number.isSafeInteger(value.reviewedSkills) && Number(value.reviewedSkills) >= 0
    && Number.isSafeInteger(value.totalSkills) && Number(value.totalSkills) >= Number(value.reviewedSkills)
    && Array.isArray(value.related) && value.related.length <= 4 && new Set(value.related.map(item => record(item) && item.id)).size === value.related.length
    && value.related.every(item => record(item) && uuid(item.id) && string(item.name, 200) && positive(item.revision) && typeof item.enabled === 'boolean'
      && (item.kind === 'reuse' || item.kind === 'overlap') && string(item.reason, 300))
}
export function validGuard(value: unknown): value is GuardRule {
  if (!record(value) || !uuid(value.id) || !string(value.name, 100) || !value.name.trim() || value.definitionVersion !== 1 || typeof value.enabled !== 'boolean' || !string(value.reason, 240) || !value.reason.trim() || !record(value.target)) return false
  if (!['deny_action', 'require_approval', 'amount_limit'].includes(String(value.kind)) || !['refund_payment', 'external_action'].includes(String(value.target.tool))) return false
  const fields = ['id', 'name', 'definitionVersion', 'enabled', 'target', 'reason', 'kind', ...(value.kind === 'amount_limit' ? ['maxAmountCents', 'currency'] : [])]
  if (Object.keys(value).some(key => !fields.includes(key)) || Object.keys(value.target).some(key => !['tool', 'integrationId', 'operationKey'].includes(key))) return false
  if (value.target.integrationId !== undefined && (!string(value.target.integrationId, 64) || !/^[a-zA-Z0-9_.-]+$/.test(value.target.integrationId))) return false
  if (value.target.operationKey !== undefined && (!string(value.target.operationKey, 510) || !value.target.operationKey.length)) return false
  if (value.target.tool === 'refund_payment' && (value.target.integrationId !== undefined || value.target.operationKey !== undefined)) return false
  return value.kind !== 'amount_limit' || (value.target.tool === 'refund_payment' && Number.isSafeInteger(value.maxAmountCents) && Number(value.maxAmountCents) >= 0 && Number(value.maxAmountCents) <= 100000000 && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency))
}
export function validGuardConfiguration(value: unknown): value is GuardConfiguration {
  return record(value) && (value.canGenerate === undefined || typeof value.canGenerate === 'boolean') && positive(value.version) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && Array.isArray(value.rules) && value.rules.length <= 30 && value.rules.every(validGuard) && new Set(value.rules.map(rule => rule.id)).size === value.rules.length && Array.isArray(value.definitions) && value.definitions.length === 3 && value.definitions.every(item => record(item) && ['deny_action', 'require_approval', 'amount_limit'].includes(String(item.kind)) && item.definitionVersion === 1 && string(item.title) && string(item.description) && Array.isArray(item.targetTools) && item.targetTools.length > 0 && item.targetTools.every(tool => ['refund_payment', 'external_action'].includes(String(tool)))) && new Set(value.definitions.map(item => item.kind)).size === 3
}
function facts(value: unknown): value is ActivityFacts | null {
  return value === null || (record(value) && Object.keys(value).length <= 40 && Object.entries(value).every(([key, field]) => key.length <= 100 && (field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field)) || string(field, 4000) || strings(field))))
}
function activityContext(value: unknown): value is ActivityContext | null {
  if (value === null) return true
  if (!record(value) || !positive(value.settingsVersion) || !Number.isSafeInteger(value.guardRevision) || Number(value.guardRevision) < 0 || !string(value.provider) || !string(value.model)) return false
  if (!Array.isArray(value.guards) || value.guards.length > 30 || !value.guards.every(validGuard)) return false
  if (value.availableSkills !== undefined && (!Array.isArray(value.availableSkills) || value.availableSkills.some(skill => !record(skill) || Object.keys(skill).length !== 5 || !['id', 'name', 'revision', 'purpose', 'activation'].every(key => Object.hasOwn(skill, key)) || !string(skill.id, 200) || !skill.id.trim() || !string(skill.name, 200) || !skill.name.trim() || !positive(skill.revision) || !string(skill.purpose, 240) || !skill.purpose.trim() || !['always', 'on_demand'].includes(String(skill.activation))) || new Set(value.availableSkills.map(skill => skill.id)).size !== value.availableSkills.length)) return false
  return Array.isArray(value.skills) && value.skills.every(skill => record(skill) && string(skill.id) && string(skill.name, 200) && positive(skill.revision) && typeof skill.contentHash === 'string' && /^[a-f0-9]{64}$/.test(skill.contentHash) && string(skill.preview, 240) && typeof skill.truncated === 'boolean' && Number.isSafeInteger(skill.loadedCharacters) && Number.isSafeInteger(skill.totalCharacters) && Number(skill.totalCharacters) >= 0 && skill.loadedCharacters === Math.min(Number(skill.totalCharacters), 8000) && skill.truncated === (Number(skill.totalCharacters) > 240) && skill.preview.length === Math.min(Number(skill.totalCharacters), 240))
}
/** Only the server's bounded public activity DTO is rendered, never SDK/session events. */
export function validAgentActivity(value: unknown, detail: Pick<CaseDetail, 'proposals' | 'requestCatalog'>): value is AgentActivity | undefined {
  if (value === undefined) return true
  if (!record(value) || !['recorded', 'not_recorded'].includes(String(value.status)) || typeof value.hasMore !== 'boolean' || !Array.isArray(value.events) || value.events.length > 100 || (value.status === 'not_recorded' && value.events.length > 0) || new Set(value.events.map(event => record(event) ? event.id : null)).size !== value.events.length) return false
  const proposals = new Set(detail.proposals.map(proposal => proposal.id))
  const requests = new Set(detail.requestCatalog?.requests.map(item => item.id) ?? [])
  return value.events.every(event => record(event) && string(event.id) && string(event.runId) && positive(event.sequence) && (event.turnJobId === null || string(event.turnJobId)) && (event.callId === null || string(event.callId)) && date(event.createdAt) && ['context', 'tool_call', 'tool_result', 'decision', 'fallback', 'guard'].includes(String(event.type)) && ['started', 'succeeded', 'proposed', 'denied', 'failed', 'unknown', 'fallback'].includes(String(event.outcome)) && (event.tool === null || string(event.tool)) && string(event.summary, 4000) && (event.reason === null || string(event.reason, 4000)) && (event.proposalId === null || (typeof event.proposalId === 'string' && proposals.has(event.proposalId))) && strings(event.requestIds) && event.requestIds.every(id => requests.has(id)) && facts(event.input) && facts(event.result) && Array.isArray(event.checks) && event.checks.length <= 100 && event.checks.every(check => record(check) && string(check.name) && typeof check.passed === 'boolean' && string(check.detail, 4000)) && activityContext(event.context))
}
