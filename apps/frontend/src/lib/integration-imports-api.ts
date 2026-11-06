import { ApiError, request } from './api'
import { validIntegrationSummary, type IntegrationPolicy, type IntegrationSummary, type PermissionMode } from './integrations-api'

export interface ScopeBinding { in: 'path' | 'query' | 'body' | 'header'; name: string }
export interface OperationReview {
  effect: 'read' | 'write'; scope: { customerId: ScopeBinding; businessId?: ScopeBinding }; outputFields: string[]
  guard?: string | null; idempotency?: { header: string } | null; reconciliation?: { operationKey: string } | null
}
export interface ImportCandidate {
  operationKey: string; method: string; path: string; title: string; description: string; tags: string[]; supported: boolean; reasonCode: string | null
  inputSchema: Record<string, unknown> | null; parameters: Record<string, 'path' | 'query' | 'body'>
  scope: OperationReview['scope'] | null; outputFields: string[]; outputCandidates: string[]; idempotencyHeaderCandidates: string[]; proposedEffect: 'read' | 'write' | 'unknown'
}
export interface ImportCapabilities {
  enabled: boolean; maxSpecBytes: number
  credentialProfiles: { id: string; name: string; configured: boolean; upstreamBaseUrl: string | null }[]
  guardDefinitions: { id: string; name: string }[]
}
export interface ImportPreview {
  id: string; version: number; expiresAt: string; status: 'prepared' | 'confirmed'; integrationId: string; specHash: string
  source: { specUrl: string; upstreamBaseUrl: string }; credential: { profileId: string; configured: boolean }
  operations: (ImportCandidate & { mode: 'deny' })[]
}
export interface PrepareImport { integrationId: string; specUrl: string; upstreamBaseUrl?: string; credentialProfileId: string }
export interface ConfirmImport { version: number; specHash: string; operations: { operationKey: string; mode: PermissionMode; review?: OperationReview }[] }
export interface ImportResult { integration: IntegrationSummary; policy: IntegrationPolicy; runtime: 'ready' | 'unavailable'; activation: 'active' | 'disabled' }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length <= max
const strings = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every(item => text(item, 200))
const validUrl = (value: unknown) => {
  if (!text(value)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
}
const binding = (value: unknown) => record(value) && ['path', 'query', 'body', 'header'].includes(String(value.in)) && text(value.name, 64) && !!value.name
const scope = (value: unknown) => record(value) && binding(value.customerId) && (value.businessId === undefined || binding(value.businessId))
export const validImportCandidate = (value: unknown) => record(value) && text(value.operationKey, 510) && value.operationKey === `${value.method} ${value.path}` && text(value.path, 500) && text(value.title, 200) && text(value.description, 2000)
  && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(String(value.method)) && strings(value.tags, 20)
  && typeof value.supported === 'boolean' && (value.reasonCode === null || text(value.reasonCode, 100)) && (value.inputSchema === null || record(value.inputSchema))
  && record(value.parameters) && Object.values(value.parameters).every(item => ['path', 'query', 'body'].includes(String(item)))
  && (value.scope === null || scope(value.scope)) && strings(value.outputFields, 30) && strings(value.outputCandidates, 100) && strings(value.idempotencyHeaderCandidates, 20) && ['read', 'write', 'unknown'].includes(String(value.proposedEffect))
const invalid = () => new ApiError(200, '', undefined, { key: 'core.error.invalidResponse' })
const path = (businessId: string, suffix: string) => `/integration-imports${suffix}?businessId=${encodeURIComponent(businessId)}`

export async function loadImportCapabilities(businessId: string, token: string, signal?: AbortSignal): Promise<ImportCapabilities> {
  const value = await request<ImportCapabilities>(path(businessId, '/capabilities'), token, { signal })
  if (!record(value) || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.maxSpecBytes) || value.maxSpecBytes < 1
    || !Array.isArray(value.credentialProfiles) || value.credentialProfiles.length > 100 || !value.credentialProfiles.every(row => record(row) && text(row.id, 64) && text(row.name, 100) && typeof row.configured === 'boolean' && (row.upstreamBaseUrl === null || validUrl(row.upstreamBaseUrl)))
    || !Array.isArray(value.guardDefinitions) || value.guardDefinitions.length > 100 || !value.guardDefinitions.every(row => record(row) && text(row.id, 100) && text(row.name, 200))) throw invalid()
  return value
}

export async function prepareImport(body: PrepareImport, businessId: string, token: string, signal?: AbortSignal): Promise<ImportPreview> {
  const value = await request<ImportPreview>(path(businessId, '/prepare'), token, { method: 'POST', body, signal })
  if (!record(value) || !text(value.id, 100) || !Number.isInteger(value.version) || value.version < 1 || !text(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))
    || !['prepared', 'confirmed'].includes(String(value.status)) || value.integrationId !== body.integrationId || !/^[a-f0-9]{64}$/.test(value.specHash)
    || !record(value.source) || !validUrl(value.source.specUrl) || !validUrl(value.source.upstreamBaseUrl) || !record(value.credential) || value.credential.profileId !== body.credentialProfileId || typeof value.credential.configured !== 'boolean'
    || !Array.isArray(value.operations) || value.operations.length > 1000 || !value.operations.every(row => validImportCandidate(row) && row.mode === 'deny') || new Set(value.operations.map(row => row.operationKey)).size !== value.operations.length) throw invalid()
  return value
}

export async function confirmImport(id: string, body: ConfirmImport, businessId: string, integrationId: string, token: string, signal?: AbortSignal): Promise<ImportResult> {
  const value = await request<ImportResult>(path(businessId, `/${encodeURIComponent(id)}/confirm`), token, { method: 'POST', body, signal })
  if (!record(value) || !validIntegrationSummary(value.integration) || value.integration.businessId !== businessId || value.integration.integrationId !== integrationId
    || !record(value.policy) || value.policy.businessId !== businessId || value.policy.integrationId !== integrationId || !['ready', 'unavailable'].includes(value.runtime) || !['active', 'disabled'].includes(value.activation)
    || (value.activation === 'active' && (value.runtime !== 'ready' || !value.integration.enabled)) || (value.activation === 'disabled' && value.integration.enabled)) throw invalid()
  return value
}

export function importErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object' || Array.isArray(error.payload)) return null
  const code = (error.payload as Record<string, unknown>).code
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null
}
