import type { ImportCapabilities, ImportPreview, ImportResult } from '../lib/integration-imports-api'

export const importBusiness = '20000000-0000-4000-8000-000000000001'
export const readKey = 'GET /accounts/{account_id}/balance'
export const writeKey = 'POST /accounts/{account_id}/freeze'
export const blockedKey = 'TRACE /unsupported'
export const importCapabilities: ImportCapabilities = { enabled: true, maxSpecBytes: 5_000_000, credentialProfiles: [
  { id: 'none', name: 'No credentials', configured: true, upstreamBaseUrl: null },
  { id: 'bank-profile', name: 'Configured bank profile', configured: true, upstreamBaseUrl: 'https://api.bank.example/v1' },
  { id: 'missing', name: 'Missing profile', configured: false, upstreamBaseUrl: null },
], guardDefinitions: [] }
export function importPreview(): ImportPreview {
  const schema = { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'], additionalProperties: false }
  const scope = { customerId: { in: 'header' as const, name: 'X-Customer-Id' }, businessId: { in: 'header' as const, name: 'X-Business-Id' } }
  return { id: '30000000-0000-4000-8000-000000000001', version: 2, expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'prepared', integrationId: 'api-api.bank.example', specHash: 'a'.repeat(64), source: { specUrl: 'https://api.bank.example/openapi.json', upstreamBaseUrl: 'https://api.bank.example/v1' }, credential: { profileId: 'bank-profile', configured: true }, operations: [
    { operationKey: readKey, method: 'GET', path: '/accounts/{account_id}/balance', title: 'Read balance', description: 'Original API description <script> is plain text.', tags: ['Accounts'], supported: true, reasonCode: null, inputSchema: schema, parameters: { account_id: 'path' }, scope, outputFields: ['balance_cents', 'currency', 'receipt_id'], outputCandidates: ['balance_cents', 'currency', 'receipt_id'], idempotencyHeaderCandidates: [], proposedEffect: 'read', mode: 'deny' },
    { operationKey: writeKey, method: 'POST', path: '/accounts/{account_id}/freeze', title: 'Freeze card', description: 'Only the scoped customer card.', tags: ['Cards'], supported: true, reasonCode: null, inputSchema: schema, parameters: { account_id: 'path' }, scope, outputFields: ['status', 'effect_id'], outputCandidates: ['status', 'effect_id'], idempotencyHeaderCandidates: ['Idempotency-Key'], proposedEffect: 'write', mode: 'deny' },
    { operationKey: blockedKey, method: 'TRACE', path: '/unsupported', title: 'Unsupported trace', description: '', tags: [], supported: false, reasonCode: 'unsupported_method', inputSchema: null, parameters: {}, scope: null, outputFields: [], outputCandidates: [], idempotencyHeaderCandidates: [], proposedEffect: 'unknown', mode: 'deny' },
  ] }
}
export function importResult(active = true): ImportResult {
  const hash = 'b'.repeat(64)
  return { integration: { businessId: importBusiness, integrationId: 'api-api.bank.example', enabled: active, draining: false, activeManifestHash: active ? hash : null, loadedManifestHash: hash, connectionRevision: '1', policyRevision: 2, version: 2, updatedAt: new Date().toISOString(), defaultMode: 'deny' },
    policy: { businessId: importBusiness, integrationId: 'api-api.bank.example', enabled: active, manifestHash: hash, policyRevision: 2, defaultMode: 'deny', groups: [], operations: [] }, runtime: active ? 'ready' : 'unavailable', activation: active ? 'active' : 'disabled' }
}
