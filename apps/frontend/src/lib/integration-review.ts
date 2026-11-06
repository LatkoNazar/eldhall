import type { ConfirmImport, ImportCandidate, ImportPreview, OperationReview, ScopeBinding } from './integration-imports-api'
import type { PermissionMode } from './integrations-api'

export interface ReviewDraft {
  effect: 'read' | 'write' | 'unknown'; customerLocation: ScopeBinding['in']; customerName: string
  bindBusiness: boolean; businessLocation: ScopeBinding['in']; businessName: string; outputs: string
  guard: string; idempotencyHeader: string; reconciliationKey: string
}
export interface ImportOperationDraft { mode: PermissionMode; review: ReviewDraft }
export const initialReview = (operation: ImportCandidate): ReviewDraft => ({
  effect: 'unknown', customerLocation: operation.scope?.customerId.in ?? 'header', customerName: operation.scope?.customerId.name ?? '',
  bindBusiness: !!operation.scope?.businessId, businessLocation: operation.scope?.businessId?.in ?? 'header', businessName: operation.scope?.businessId?.name ?? '',
  outputs: operation.outputFields.join(', '), guard: '', idempotencyHeader: operation.idempotencyHeaderCandidates.length === 1 ? operation.idempotencyHeaderCandidates[0]! : '', reconciliationKey: '',
})
const fieldName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !['__proto__', 'constructor', 'prototype', 'eldhall'].includes(name)
const headerName = (name: string) => /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)
const binding = (location: ScopeBinding['in'], name: string): ScopeBinding | null => (location === 'header' ? headerName(name) : fieldName(name)) ? { in: location, name } : null

export function reviewedDefinition(draft: ReviewDraft): OperationReview | null {
  const customer = binding(draft.customerLocation, draft.customerName.trim())
  const business = draft.bindBusiness ? binding(draft.businessLocation, draft.businessName.trim()) : null
  const outputs = draft.outputs.split(',').map(value => value.trim()).filter(Boolean)
  if (draft.effect === 'unknown' || !customer || (draft.bindBusiness && !business)
    || !outputs.length || outputs.length > 30 || outputs.some(name => !fieldName(name)) || new Set(outputs).size !== outputs.length
    || (draft.idempotencyHeader && !headerName(draft.idempotencyHeader)) || draft.guard.length > 100) return null
  if (business?.in === customer.in && (customer.in === 'header' ? business.name.toLowerCase() === customer.name.toLowerCase() : business.name === customer.name)) return null
  return { effect: draft.effect, scope: { customerId: customer, ...(business ? { businessId: business } : {}) }, outputFields: outputs,
    guard: draft.guard || null, idempotency: draft.effect === 'write' && draft.idempotencyHeader ? { header: draft.idempotencyHeader } : null,
    reconciliation: draft.effect === 'write' && draft.reconciliationKey ? { operationKey: draft.reconciliationKey } : null }
}

/** Build the exact explicit confirmation, with no inferred permission or review. */
export function importConfirmation(preview: ImportPreview, drafts: Record<string, ImportOperationDraft>): ConfirmImport | null {
  const operations: ConfirmImport['operations'] = []
  for (const operation of preview.operations) {
    const row = drafts[operation.operationKey]
    if (!row || !['deny', 'ask', 'auto'].includes(row.mode) || (!operation.supported && row.mode !== 'deny')) return null
    const review = operation.supported ? reviewedDefinition(row.review) : null
    if (operation.supported && !review) return null
    if (review?.reconciliation) {
      const target = preview.operations.find(item => item.operationKey === review.reconciliation!.operationKey && item.supported)
      const targetReview = target && drafts[target.operationKey] ? reviewedDefinition(drafts[target.operationKey]!.review) : null
      if (!targetReview || targetReview.effect !== 'read' || targetReview.guard) return null
    }
    operations.push({ operationKey: operation.operationKey, mode: row.mode, ...(review ? { review } : {}) })
  }
  return { version: preview.version, specHash: preview.specHash, operations }
}
