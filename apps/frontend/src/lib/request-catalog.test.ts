import { expect, it } from 'vitest'
import { requestFixture, uuid } from '../test/request-fixtures'
import { blockedRequestProposals, requestNeedsVerification, requestProposals, validRequestCatalog, waitingDependencies } from './request-catalog'

it('validates a real four-request/one-chat DTO without inventing requests for legacy cases', () => {
  const detail = requestFixture()
  expect(validRequestCatalog(detail.requestCatalog, detail)).toBe(true)
  expect(validRequestCatalog(undefined, detail)).toBe(true)
  expect(requestProposals(detail.requestCatalog!.requests[2]!, detail)).toEqual([detail.proposals[0]])
  expect(waitingDependencies(detail.requestCatalog!.requests[1]!, detail.requestCatalog!)).toEqual([detail.requestCatalog!.requests[0]])
})

it('rejects malformed catalogs and cross-case messages/actions instead of treating them as local evidence', () => {
  const source = requestFixture()
  for (const change of [
    (detail: typeof source) => { detail.requestCatalog!.requests[0]!.sourceMessageIds = [uuid(999)] },
    (detail: typeof source) => { detail.messages[0]!.caseId = uuid(999) },
    (detail: typeof source) => { detail.proposals[0]!.caseId = uuid(999) },
    (detail: typeof source) => { detail.customer.businessId = uuid(999) },
    (detail: typeof source) => { detail.customer.id = uuid(999) },
    (detail: typeof source) => { detail.requestCatalog!.requests[1]!.dependencyIds = [uuid(999)] },
    (detail: typeof source) => { detail.requestCatalog!.requests[0]!.dependencyIds = [uuid(1)] },
    (detail: typeof source) => { detail.requestCatalog!.requests[0]!.number = 2 },
    (detail: typeof source) => { detail.requestCatalog!.history.events[0]!.snapshot.id = uuid(999) },
    (detail: typeof source) => { detail.requestCatalog!.requests[3]!.fulfillment!.proof.messageIds = [uuid(999)] },
  ]) {
    const detail = structuredClone(source)
    change(detail)
    expect(validRequestCatalog(detail.requestCatalog, detail)).toBe(false)
  }
  for (const value of [null, [], {}, { ...source.requestCatalog, syncState: 'streaming' }, { ...source.requestCatalog, version: -1 }]) expect(validRequestCatalog(value, source)).toBe(false)
})

it('keeps a fulfilled request independent of an approved action and reports explicit unresolved dependencies', () => {
  const detail = requestFixture()
  const catalog = detail.requestCatalog!
  const request = catalog.requests[2]!
  expect(request.lifecycle).toBe('open')
  detail.proposals[0]!.status = 'executed'
  expect(request.lifecycle).toBe('open')
  catalog.requests[0]!.lifecycle = 'fulfilled'
  expect(waitingDependencies(catalog.requests[1]!, catalog)).toEqual([])
})

it('blocks a new pending action while an old revision has an unresolved effect, preserving old action access', () => {
  const detail = requestFixture()
  const catalog = detail.requestCatalog!
  const item = catalog.requests[2]!
  item.revision = 2
  detail.proposals[0]!.status = 'unknown'
  detail.proposals.push({ ...structuredClone(detail.proposals[0]!), id: uuid(302), status: 'pending' })
  item.actions.push({ proposalId: uuid(302), requestRevision: 2 })
  expect(requestNeedsVerification(item, detail)).toBe(true)
  expect(blockedRequestProposals(catalog, detail)).toEqual(new Set([uuid(302)]))
  expect(requestProposals(item, detail)).toHaveLength(2)
  detail.proposals[0]!.status = 'failed'
  expect(blockedRequestProposals(catalog, detail).size).toBe(0)
})
