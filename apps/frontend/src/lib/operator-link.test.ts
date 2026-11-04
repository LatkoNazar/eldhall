import { beforeEach, expect, it, vi } from 'vitest'
import { consumeOperatorLink } from './operator-link'

beforeEach(() => { sessionStorage.clear(); history.replaceState({}, '', '/operator') })

it('scrubs and decodes the key without persisting it or accepting a redirect', () => {
  const key = 'synthetic+/=&key'
  history.replaceState({}, '', `/operator/knowledge?businessId=one#key=${encodeURIComponent(key)}&next=https://outside.example/`)
  expect(consumeOperatorLink()).toEqual({ key })
  expect(location.pathname + location.search + location.hash).toBe('/operator/knowledge?businessId=one')
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it.each(['key=a&key=b', 'key=%E0%A4%A', 'key=', 'key=%20', `key=${'a'.repeat(4097)}`])('rejects ambiguous or invalid fragment keys after scrubbing: %s', fragment => {
  history.replaceState({}, '', '/operator#' + fragment)
  expect(consumeOperatorLink()).toEqual({ error: 'invalid' })
  expect(location.hash).toBe('')
})

it('never adopts an operator key on customer routes or from query parameters', () => {
  sessionStorage.setItem('support.customer', 'customer-session')
  history.replaceState({}, '', '/chat/#key=operator-key')
  expect(consumeOperatorLink()).toEqual({})
  expect(location.hash).toBe('')
  history.replaceState({}, '', '/operator?key=query-key#conversation')
  expect(consumeOperatorLink()).toEqual({})
  expect(sessionStorage.getItem('support.customer')).toBe('customer-session')
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it('does not expose a candidate if history scrubbing is blocked', () => {
  history.replaceState({}, '', '/operator#key=private-candidate')
  vi.spyOn(history, 'replaceState').mockImplementation(() => { throw new Error('blocked') })
  expect(consumeOperatorLink()).toEqual({ error: 'unscrubbed' })
})
