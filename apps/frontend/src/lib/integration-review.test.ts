import { expect, it } from 'vitest'
import { importConfirmation, initialReview, reviewedDefinition, type ImportOperationDraft } from './integration-review'
import { blockedKey, importPreview, readKey, writeKey } from '../test/integration-import-fixtures'

function drafts() {
  const preview = importPreview()
  const value: Record<string, ImportOperationDraft> = Object.fromEntries(preview.operations.map(operation => [operation.operationKey, { mode: 'deny', review: initialReview(operation) }]))
  return { preview, value }
}
it('leaves all effects Unknown, even GET/POST suggestions, and requires review for supported Deny tools', () => {
  const { preview, value } = drafts()
  expect(value[readKey]!.review.effect).toBe('unknown')
  expect(value[writeKey]!.review.effect).toBe('unknown')
  expect(importConfirmation(preview, value)).toBeNull()
  value[readKey]!.review.effect = 'read'
  expect(importConfirmation(preview, value)).toBeNull()
  value[writeKey]!.review.effect = 'write'
  const result = importConfirmation(preview, value)!
  expect(result.operations.map(operation => [operation.mode, !!operation.review])).toEqual([['deny', true], ['deny', true], ['deny', false]])
  expect(result.operations[1]!.review!.idempotency).toEqual({ header: 'Idempotency-Key' })
})
it('does not compile unsupported positive modes or incomplete/unsafe identity and output mappings', () => {
  const { preview, value } = drafts()
  value[readKey]!.review.effect = 'read'; value[writeKey]!.review.effect = 'write'
  value[blockedKey]!.mode = 'auto'
  expect(importConfirmation(preview, value)).toBeNull()
  value[blockedKey]!.mode = 'deny'
  for (const patch of [{ customerName: '' }, { outputs: 'status,status' }, { outputs: '__proto__' }, { businessName: 'x-customer-id' }, { idempotencyHeader: 'Bad Header' }]) {
    expect(reviewedDefinition({ ...value[readKey]!.review, ...patch })).toBeNull()
  }
  expect(importConfirmation(preview, value)).not.toBeNull()
})
it('requires reconciliation to reference an explicitly reviewed unguarded read in the same preview', () => {
  const { preview, value } = drafts()
  value[writeKey]!.review.effect = 'write'; value[writeKey]!.review.reconciliationKey = readKey
  expect(importConfirmation(preview, value)).toBeNull()
  value[readKey]!.review.effect = 'read'
  expect(importConfirmation(preview, value)).not.toBeNull()
  value[readKey]!.review.guard = 'registered.guard'
  expect(importConfirmation(preview, value)).toBeNull()
  value[readKey]!.review.guard = ''; value[writeKey]!.review.reconciliationKey = 'GET /foreign'
  expect(importConfirmation(preview, value)).toBeNull()
})
