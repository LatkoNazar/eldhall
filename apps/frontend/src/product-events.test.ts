import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentAnalytics, initAnalytics, validateProductEvent } from '@eldhall/analytics'

const env = { PUBLIC_UMAMI_SCRIPT_URL: 'https://metrics.eldhall.com/script.js', PUBLIC_UMAMI_WEBSITE_ID: '82847d30-5f10-4437-a05d-dc286581bb0e' }
type TestWindow = Window & { umami?: { track: ReturnType<typeof vi.fn> }; __eldhallAnalytics?: unknown; __eldhallBeforeSend?: unknown }
const browser = window as TestWindow

beforeEach(() => { window.history.replaceState({}, '', '/'); sessionStorage.clear(); delete browser.umami; delete browser.__eldhallAnalytics; delete browser.__eldhallBeforeSend })
afterEach(() => { document.querySelectorAll('script[data-website-id]').forEach(script => script.remove()) })

describe('product event allow-list', () => {
  it('accepts only declared enum properties', () => {
    expect(validateProductEvent('action_failed', { tool: 'refund_payment', outcome: 'unknown' })).toEqual({ tool: 'refund_payment', outcome: 'unknown' })
    expect(validateProductEvent('support_case_created', {})).toEqual({})
  })

  it('drops events carrying personal or payment data, unknown values or unknown events', () => {
    expect(validateProductEvent('support_case_created', { email: 'olena@example.test' })).toBeNull()
    expect(validateProductEvent('action_executed', { tool: 'refund_payment', amount_cents: '49900' })).toBeNull()
    expect(validateProductEvent('action_executed', { tool: 'Ви списали двічі' })).toBeNull()
    expect(validateProductEvent('action_failed', { tool: 'refund_payment' })).toBeNull()
    expect(validateProductEvent('chat_text', {})).toBeNull()
  })
})

describe('track()', () => {
  it('is a no-op without Umami configuration and makes no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = initAnalytics({}, 'app')
    expect(client.enabled).toBe(false)
    expect(() => client.track('demo_started', { scenario: 'refund' })).not.toThrow()
    expect(currentAnalytics().enabled).toBe(false)
    expect(document.querySelector('script[data-website-id]')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('sends only validated data and survives a failing collector', () => {
    const client = initAnalytics(env, 'app')
    const track = vi.fn().mockImplementation(() => { throw new Error('collector down') })
    browser.umami = { track }
    document.querySelector('script[data-website-id]')!.dispatchEvent(new Event('load'))
    expect(() => client.track('action_executed', { tool: 'refund_payment' })).not.toThrow()
    expect(track).toHaveBeenLastCalledWith('action_executed', { surface: 'app', tool: 'refund_payment' })
    // A payload outside the schema never reaches the collector.
    client.track('action_executed', { tool: 'refund_payment', payment_id: 'p-1' } as never)
    expect(track).toHaveBeenCalledTimes(2) // app_opened + one valid event
    expect(currentAnalytics()).toBe(client)
  })
})
