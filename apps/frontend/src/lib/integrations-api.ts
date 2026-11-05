import type { AppMessageKey, Translate } from '../i18n'
import { ApiError, request } from './api'

export type PermissionMode = 'auto' | 'ask' | 'deny'
export type RuleMode = PermissionMode | 'inherit'
export interface IntegrationSummary {
  businessId: string; integrationId: string; enabled: boolean; draining: boolean
  activeManifestHash: string | null; loadedManifestHash: string; connectionRevision: string
  policyRevision: number; version: number; updatedAt: string; defaultMode: PermissionMode
}
export interface PermissionGroup { id: string; selector: { tag: string } | { operationKeys: string[] }; mode: RuleMode }
export interface IntegrationPolicy {
  businessId: string; integrationId: string; enabled: boolean; manifestHash: string; policyRevision: number
  defaultMode: PermissionMode; groups: PermissionGroup[]
  operations: { operationKey: string; enabled: boolean; reviewedOperationHash: string | null; mode: RuleMode }[]
}
export interface CatalogOperation {
  operationKey: string; operationId: string | null; toolName: string; method: string; path: string
  title: string; description: string; tags: string[]; effect: 'read' | 'write' | 'unknown'
  operationHash: string; enabled: boolean; reviewedOperationHash: string | null; mode: RuleMode
  inputSchema?: Record<string, unknown>; parameters?: Record<string, unknown>; scope?: Record<string, unknown>
  outputFields?: string[]; guard?: string | null; idempotency?: unknown; reconciliation?: unknown
  effective: { mode: PermissionMode; source: 'operation' | 'group' | 'integration' | 'guard'; matchedRuleIds: string[]; policyRevision: number | null; reasonCode: string }
}
export interface IntegrationCatalog { integration: IntegrationSummary; groups: PermissionGroup[]; operations: CatalogOperation[] }
export interface IntegrationPolicyResponse { integration: IntegrationSummary; policy: IntegrationPolicy }
const modeLabels: Record<RuleMode, AppMessageKey> = { auto: 'core.mode.auto', ask: 'core.mode.ask', deny: 'core.mode.deny', inherit: 'core.mode.inherit' }
export const modeLabel = (mode: RuleMode, t: Translate) => t(modeLabels[mode])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const modes = ['auto', 'ask', 'deny']
const ruleMode = (value: unknown) => [...modes, 'inherit'].includes(String(value))
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const summary = (value: unknown) => record(value) && typeof value.integrationId === 'string' && typeof value.businessId === 'string' && typeof value.enabled === 'boolean' && typeof value.draining === 'boolean' && hash(value.loadedManifestHash) && (value.activeManifestHash === null || hash(value.activeManifestHash)) && typeof value.connectionRevision === 'string' && Number.isInteger(value.version) && Number(value.version) > 0 && Number.isInteger(value.policyRevision) && Number(value.policyRevision) > 0 && modes.includes(String(value.defaultMode)) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
const group = (value: unknown) => record(value) && typeof value.id === 'string' && ruleMode(value.mode) && record(value.selector) && (typeof value.selector.tag === 'string' || strings(value.selector.operationKeys))
const operation = (value: unknown) => record(value) && ['operationKey', 'title', 'description', 'method', 'path', 'toolName'].every(key => typeof value[key] === 'string') && hash(value.operationHash) && strings(value.tags) && ['read', 'write', 'unknown'].includes(String(value.effect)) && typeof value.enabled === 'boolean' && (value.reviewedOperationHash === null || hash(value.reviewedOperationHash)) && ruleMode(value.mode) && record(value.inputSchema) && record(value.parameters) && record(value.scope) && strings(value.outputFields) && record(value.effective) && modes.includes(String(value.effective.mode)) && ['operation', 'group', 'integration', 'guard'].includes(String(value.effective.source)) && strings(value.effective.matchedRuleIds) && typeof value.effective.reasonCode === 'string'
export const integrationPath = (id: string, businessId: string, suffix = '') => `/integrations/${encodeURIComponent(id)}${suffix}?businessId=${encodeURIComponent(businessId)}`
export async function loadIntegrations(businessId: string, token: string, signal?: AbortSignal) {
  const value = await request<{ integrations: IntegrationSummary[] }>(`/integrations?businessId=${encodeURIComponent(businessId)}`, token, { signal })
  if (!Array.isArray(value.integrations) || !value.integrations.every(item => summary(item) && item.businessId === businessId)) throw new ApiError(200, '', undefined, { key: 'core.error.invalidResponse' })
  return value
}
export async function loadIntegration(id: string, businessId: string, token: string, signal?: AbortSignal) {
  const [catalog, policy] = await Promise.all([
    request<IntegrationCatalog>(integrationPath(id, businessId, '/operations'), token, { signal }),
    request<IntegrationPolicyResponse>(integrationPath(id, businessId, '/policy'), token, { signal }),
  ])
  if (!summary(catalog.integration) || !summary(policy.integration) || catalog.integration.businessId !== businessId || policy.integration.businessId !== businessId || catalog.integration.integrationId !== id || policy.integration.integrationId !== id || !Array.isArray(catalog.operations) || !Array.isArray(catalog.groups) || !catalog.groups.every(group)
    || !record(policy.policy) || !Array.isArray(policy.policy.groups) || !Array.isArray(policy.policy.operations)
    || policy.policy.integrationId !== id || policy.policy.businessId !== businessId || !modes.includes(policy.policy.defaultMode) || !policy.policy.groups.every(group) || !policy.policy.operations.every(rule => record(rule) && typeof rule.operationKey === 'string' && ruleMode(rule.mode) && typeof rule.enabled === 'boolean' && (rule.reviewedOperationHash === null || hash(rule.reviewedOperationHash))) || !catalog.operations.every(operation)) throw new ApiError(200, '', undefined, { key: 'core.error.invalidResponse' })
  if (catalog.integration.version !== policy.integration.version || catalog.integration.loadedManifestHash !== policy.integration.loadedManifestHash) throw new ApiError(409, '', undefined, { key: 'core.error.catalogChanged' })
  return { catalog, policy }
}

export function decisionLabel(operation: CatalogOperation, t: Translate) {
  const decision = operation.effective
  if (decision.source === 'guard') {
    const reasons: Record<string, AppMessageKey> = {
      operation_disabled: 'core.permission.operationDisabled', operation_unreviewed: 'core.permission.operationUnreviewed',
      operation_changed: 'core.permission.operationChanged', integration_disabled: 'core.permission.integrationDisabled',
      integration_draining: 'core.permission.draining', manifest_mismatch: 'core.permission.manifestMismatch',
      effect_unknown: 'core.permission.effectUnknown', effect_unreviewed: 'core.permission.effectUnreviewed',
    }
    const key = reasons[decision.reasonCode]
    return key ? t(key) : t('core.permission.guard', { reason: decision.reasonCode })
  }
  const mode = modeLabel(decision.mode, t)
  return decision.source === 'operation' ? t('core.permission.own', { mode }) : decision.source === 'group' ? t('core.permission.group', { mode, rules: decision.matchedRuleIds.join(', ') }) : t('core.permission.default', { mode })
}
