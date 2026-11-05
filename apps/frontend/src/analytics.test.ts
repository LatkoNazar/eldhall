import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquisitionContext, appLink, campaignFromUrl, initAnalytics, sanitizeAnalyticsUrl, trackSignupCompleted,
} from '@eldhall/analytics'

const env = {
  PUBLIC_UMAMI_SCRIPT_URL: 'https://metrics.eldhall.com/script.js',
  PUBLIC_UMAMI_WEBSITE_ID: '82847d30-5f10-4437-a05d-dc286581bb0e',
}
type TestWindow = Window & {
  umami?: { track: ReturnType<typeof vi.fn> }
  __eldhallAnalytics?: unknown
  __eldhallBeforeSend?: (type: string, payload: Record<string, unknown>) => Record<string, unknown>
}
const browser = window as TestWindow

function ready() {
  const track = vi.fn().mockResolvedValue(undefined)
  browser.umami = { track }
  document.querySelector('script[data-website-id]')!.dispatchEvent(new Event('load'))
  return track
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  sessionStorage.clear()
  delete browser.umami
  delete browser.__eldhallAnalytics
  delete browser.__eldhallBeforeSend
})
afterEach(() => {
  document.querySelectorAll('script[data-website-id]').forEach(script => script.remove())
  document.body.innerHTML = ''
  vi.unstubAllEnvs()
})

describe('campaign attribution', () => {
  it('relays only bounded marketing parameters to an actual cross-origin href', () => {
    const campaign = campaignFromUrl('https://eldhall.com/?utm_source=launch&utm_medium=social&utm_campaign=mvp&utm_content=hero&utm_term=tools&email=test@example.com&token=private#secret')
    expect(appLink('https://app.eldhall.com/?redirect=bad#token', campaign)).toBe('https://app.eldhall.com/?utm_source=launch&utm_medium=social&utm_campaign=mvp&utm_content=hero&utm_term=tools')
    expect(appLink('javascript:alert(1)', campaign)).toBeNull()
    expect(appLink('https://user:password@app.eldhall.com', campaign)).toBeNull()
    expect(appLink(undefined, campaign)).toBeNull()
  })

  it('drops personal-data-shaped and oversized UTM values', () => {
    expect(campaignFromUrl(`https://eldhall.com/?utm_source=user@example.com&utm_campaign=${'a'.repeat(101)}&utm_medium=social`)).toEqual({ utm_medium: 'social' })
  })

  it('preserves first acquisition in this origin tab through subsequent app routes', () => {
    history.replaceState({}, '', '/?utm_source=launch&token=private')
    expect(acquisitionContext()).toEqual({ utm_source: 'launch' })
    history.replaceState({}, '', '/next?utm_source=later')
    expect(acquisitionContext()).toEqual({ utm_source: 'launch' })
    history.replaceState({}, '', '/next')
    expect(acquisitionContext()).toEqual({ utm_source: 'launch' })
  })

  it('works even when session storage is unavailable', () => {
    history.replaceState({}, '', '/?utm_campaign=mvp')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(acquisitionContext()).toEqual({ utm_campaign: 'mvp' })
  })

  it('sanitizes page and external referrer query strings, hashes and credentials', () => {
    expect(sanitizeAnalyticsUrl('/?email=private&utm_source=launch#secret', location.href)).toBe('/?utm_source=launch')
    expect(sanitizeAnalyticsUrl('https://example.com/search?q=private&utm_medium=social#private', location.href)).toBe('https://example.com/search?utm_medium=social')
    expect(sanitizeAnalyticsUrl('javascript:private', location.href)).toBe('')
    expect(sanitizeAnalyticsUrl('https://user:password@example.com/', location.href)).toBe('https://example.com/')
  })
})

describe('non-blocking Umami integration', () => {
  it.each([{}, { ...env, PUBLIC_UMAMI_WEBSITE_ID: 'invalid' }, { ...env, PUBLIC_UMAMI_SCRIPT_URL: 'javascript:alert(1)' }, { ...env, PUBLIC_UMAMI_DOMAINS: 'another.example' }])('does not load a tracker for missing or invalid configuration: %j', config => {
    expect(initAnalytics(config, 'landing').enabled).toBe(false)
    expect(document.querySelector('script[data-website-id]')).toBeNull()
  })

  it('queues until load, installs the sanitizer first and sends each document view once', () => {
    history.replaceState({}, '', '/?utm_source=launch&access_token=secret')
    const client = initAnalytics(env, 'landing')
    expect(initAnalytics(env, 'landing')).toBe(client)
    expect(document.querySelectorAll('script[data-website-id]')).toHaveLength(1)
    const clean = browser.__eldhallBeforeSend!('event', { url: '/?email=secret&utm_source=launch#password', referrer: 'https://ref.example/?token=secret', name: 'landing_viewed' })
    expect(clean).toEqual({ url: '/?utm_source=launch', referrer: 'https://ref.example/', name: 'landing_viewed' })
    client.trackLandingCta('hero')
    const track = ready()
    expect(track.mock.calls).toEqual([
      ['landing_viewed', { surface: 'landing', utm_source: 'launch' }],
      ['landing_cta_clicked', { surface: 'landing', location: 'hero', utm_source: 'launch' }],
    ])
    initAnalytics(env, 'app')
    initAnalytics(env, 'app')
    expect(track).toHaveBeenCalledTimes(3)
    expect(track).toHaveBeenLastCalledWith('app_opened', { surface: 'app', utm_source: 'launch' })
  })

  it('wires the real landing CTA href and never delays its native navigation', async () => {
    history.replaceState({}, '', '/?utm_source=launch&lang=en&email=private')
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.stubEnv('PUBLIC_APP_URL', 'https://app.eldhall.com/')
    document.body.innerHTML = '<a data-app-link="hero">Open app</a><span data-year></span>'
    await import('../../landing/src/main')
    const anchor = document.querySelector<HTMLAnchorElement>('a')!
    await vi.waitFor(() => expect(anchor.href).toBe('https://app.eldhall.com/?utm_source=launch&lang=en'))
    let blockedByApplication = true
    anchor.addEventListener('click', event => {
      blockedByApplication = event.defaultPrevented
      event.preventDefault() // Keep jsdom on this page after inspecting the actual application handler.
    })
    const click = new MouseEvent('click', { cancelable: true })
    anchor.dispatchEvent(click)
    expect(blockedByApplication).toBe(false)
    const track = ready()
    expect(track).toHaveBeenLastCalledWith('landing_cta_clicked', { surface: 'landing', location: 'hero', utm_source: 'launch' })
    track.mockImplementation(() => new Promise(() => {}))
    anchor.dispatchEvent(new MouseEvent('click', { cancelable: true }))
    expect(blockedByApplication).toBe(false)
  })

  it('drops queued tracking after a script failure, while calls remain harmless', () => {
    const client = initAnalytics(env, 'app')
    document.querySelector('script[data-website-id]')!.dispatchEvent(new Event('error'))
    const track = ready()
    expect(() => client.trackLandingCta('footer')).not.toThrow()
    expect(track).not.toHaveBeenCalled()
  })

  it('returns a no-op if the browser refuses script injection', () => {
    vi.spyOn(document.head, 'append').mockImplementationOnce(() => { throw new Error('Script blocked') })
    expect(initAnalytics(env, 'app').enabled).toBe(false)
    expect(document.querySelector('script[data-website-id]')).toBeNull()
  })

  it('absorbs synchronous and rejected collector failures', async () => {
    const client = initAnalytics(env, 'landing')
    const track = ready()
    track.mockImplementationOnce(() => { throw new Error('Blocked') }).mockRejectedValueOnce(new Error('Offline'))
    expect(() => client.trackLandingCta('hero')).not.toThrow()
    expect(() => client.trackLandingCta('header')).not.toThrow()
    await Promise.resolve()
  })

  it('only records a confirmed new account, deduplicates its callback and never transmits its identifier', () => {
    const client = initAnalytics(env, 'app')
    const track = ready()
    expect(track.mock.calls.map(call => call[0])).toEqual(['app_opened'])
    const result = { status: 'created', registrationId: 'internal-123', method: 'email' } as const
    trackSignupCompleted(client, result)
    trackSignupCompleted(client, result)
    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenLastCalledWith('signup_completed', { surface: 'app', method: 'email' })
    // Runtime callers can receive invalid or non-creation server responses too.
    // @ts-expect-error login is deliberately outside the success-only contract.
    trackSignupCompleted(client, { ...result, status: 'existing' })
    trackSignupCompleted(client, { ...result, registrationId: '' })
    expect(track).toHaveBeenCalledTimes(2)
  })

  it('keeps first acquisition in native event URLs after a later signup route removes the original query', () => {
    history.replaceState({}, '', '/?utm_source=launch&utm_campaign=mvp&token=initial-secret')
    const client = initAnalytics(env, 'app')
    const track = ready()
    history.replaceState({}, '', '/signup?token=later-secret#private')
    const clean = browser.__eldhallBeforeSend!('event', {
      url: '/signup?token=later-secret#private', referrer: 'https://ref.example/?utm_medium=social&email=private',
    })
    expect(clean).toEqual({
      url: '/signup?utm_source=launch&utm_campaign=mvp', referrer: 'https://ref.example/?utm_medium=social',
    })
    expect(location.search).toBe('?token=later-secret')
    trackSignupCompleted(client, { status: 'created', registrationId: 'local-only', method: 'oauth' })
    expect(track).toHaveBeenLastCalledWith('signup_completed', { surface: 'app', method: 'oauth', utm_source: 'launch', utm_campaign: 'mvp' })
    const laterCampaign = browser.__eldhallBeforeSend!('event', { url: '/next?utm_source=later&utm_medium=ad' })
    expect(laterCampaign.url).toBe('/next?utm_source=launch&utm_campaign=mvp')
  })

  it('preserves current safe URL campaigns when this document has no stored first acquisition', () => {
    initAnalytics(env, 'app')
    expect(browser.__eldhallBeforeSend!('event', { url: '/next?utm_source=later&token=private' }).url).toBe('/next?utm_source=later')
  })

  it('preserves empty direct-traffic referrers and URLs even with stored acquisition', () => {
    history.replaceState({}, '', '/?utm_source=launch&utm_campaign=mvp')
    expect(sanitizeAnalyticsUrl('', location.href)).toBe('')
    initAnalytics(env, 'landing')
    expect(browser.__eldhallBeforeSend!('event', { url: '', referrer: '' })).toEqual({ url: '', referrer: '' })
    expect(browser.__eldhallBeforeSend!('event', { url: '/', referrer: '' })).toEqual({
      url: '/?utm_source=launch&utm_campaign=mvp', referrer: '',
    })
  })
})
