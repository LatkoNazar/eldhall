import { acquisitionContext, campaignKeys, sanitizeAnalyticsUrl } from './campaign.ts'
import { validateProductEvent } from './product-events.ts'
import type { ProductEvent, ProductEventProps } from './product-events.ts'

export { acquisitionContext, appLink, campaignFromUrl, campaignKeys, sanitizeAnalyticsUrl } from './campaign.ts'
export type { Campaign } from './campaign.ts'
export { productEvents, validateProductEvent } from './product-events.ts'
export type { ProductEvent, ProductEventProps } from './product-events.ts'

export type Surface = 'landing' | 'app'

export interface PublicAnalyticsEnv {
  PUBLIC_UMAMI_SCRIPT_URL?: string
  PUBLIC_UMAMI_WEBSITE_ID?: string
  PUBLIC_UMAMI_DOMAINS?: string
}

/** Pass only a NEW-account success response from the registration API.
 * registrationId is used locally for deduplication and is never sent to Umami.
 */
export interface SignupCreated {
  status: 'created'
  registrationId: string
  method: 'email' | 'oauth' | 'passkey'
}

export interface Analytics {
  readonly enabled: boolean
  track<E extends ProductEvent>(event: E, props: ProductEventProps<E>): void
  trackLandingCta(location: 'header' | 'hero' | 'footer'): void
  trackSignupCompleted(result: SignupCreated): void
}

type Event = { name: string; data: Record<string, string> }
type Payload = Record<string, unknown>
type Tracker = { track(name: string, data: Record<string, string>): unknown }
type State = {
  client: Analytics
  queue: Event[]
  failed: boolean
  views: Set<Surface>
  registrations: Set<string>
}
type AnalyticsWindow = Window & {
  umami?: Tracker
  __eldhallAnalytics?: State
  __eldhallBeforeSend?: (type: string, payload: Payload) => Payload
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const disabled: Analytics = { enabled: false, track() {}, trackLandingCta() {}, trackSignupCompleted() {} }

/** The document's analytics client (no-op until initAnalytics configured one). */
export function currentAnalytics(page: Window = window): Analytics {
  const client = (page as AnalyticsWindow).__eldhallAnalytics?.client
  // A client cached by older code can survive Vite hot reload without track().
  // Keep it inert until a full reload instead of breaking the business flow.
  return client && typeof client.track === 'function' ? client : disabled
}

/** One tracker per document, including React StrictMode and Vite hot reloads. */
export function initAnalytics(env: PublicAnalyticsEnv, surface: Surface, page: Window = window): Analytics {
  try {
    return initialize(env, surface, page)
  } catch {
    const state = (page as AnalyticsWindow).__eldhallAnalytics
    if (state) {
      state.failed = true
      state.queue = []
    }
    return disabled
  }
}

function initialize(env: PublicAnalyticsEnv, surface: Surface, page: Window): Analytics {
  const browser = page as AnalyticsWindow
  const campaign = acquisitionContext(page)
  let scriptUrl: URL
  try {
    scriptUrl = new URL(env.PUBLIC_UMAMI_SCRIPT_URL ?? '')
    if (!['http:', 'https:'].includes(scriptUrl.protocol) || scriptUrl.username || scriptUrl.password) return disabled
  } catch {
    return disabled
  }
  const websiteId = env.PUBLIC_UMAMI_WEBSITE_ID ?? ''
  if (!uuid.test(websiteId)) return disabled
  const domains = (env.PUBLIC_UMAMI_DOMAINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (domains.length && !domains.includes(page.location.hostname)) return disabled

  const existing = browser.__eldhallAnalytics
  if (existing) {
    if (!existing.views.has(surface)) {
      existing.views.add(surface)
      send(existing, { name: surface === 'landing' ? 'landing_viewed' : 'app_opened', data: { surface, ...campaign } }, browser)
    }
    return currentAnalytics(page)
  }

  const state: State = {
    client: disabled,
    queue: [],
    failed: false,
    views: new Set([surface]),
    registrations: new Set(),
  }
  const client: Analytics = {
    enabled: true,
    track(event, props) {
      const data = validateProductEvent(event, props as Record<string, unknown>)
      if (data) send(state, { name: event, data: { surface, ...data, ...campaign } }, browser)
    },
    trackLandingCta(location) {
      send(state, { name: 'landing_cta_clicked', data: { surface: 'landing', location, ...campaign } }, browser)
    },
    trackSignupCompleted(result) {
      if (result.status !== 'created' || !result.registrationId?.trim() ||
        !['email', 'oauth', 'passkey'].includes(result.method) || state.registrations.has(result.registrationId)) return
      state.registrations.add(result.registrationId)
      send(state, { name: 'signup_completed', data: { surface: 'app', method: result.method, ...campaign } }, browser)
    },
  }
  state.client = client
  browser.__eldhallAnalytics = state
  browser.__eldhallBeforeSend = (type, payload) => {
    const clean = { ...payload }
    for (const field of ['url', 'referrer']) {
      if (typeof clean[field] === 'string') clean[field] = sanitizeAnalyticsUrl(clean[field], page.location.href)
    }
    // Umami derives native campaign columns from the event URL, not its data.
    // Keep first acquisition on later routes without changing the user's URL.
    if (type === 'event' && typeof clean.url === 'string' && clean.url && Object.keys(campaign).length) {
      const url = new URL(clean.url, page.location.href)
      for (const key of campaignKeys) url.searchParams.delete(key)
      for (const [key, value] of Object.entries(campaign)) url.searchParams.set(key, value)
      clean.url = clean.url.startsWith('/') ? `${url.pathname}${url.search}` : url.href
    }
    return clean
  }
  const script = page.document.createElement('script')
  script.src = scriptUrl.href
  script.defer = true
  script.dataset.websiteId = websiteId
  script.dataset.beforeSend = '__eldhallBeforeSend'
  script.dataset.excludeHash = 'true'
  if (domains.length) script.dataset.domains = domains.join(',')
  script.addEventListener('load', () => {
    if (!browser.umami) {
      state.failed = true
      state.queue = []
      return
    }
    for (const event of state.queue.splice(0)) send(state, event, browser)
  }, { once: true })
  script.addEventListener('error', () => {
    state.failed = true
    state.queue = []
  }, { once: true })
  send(state, { name: surface === 'landing' ? 'landing_viewed' : 'app_opened', data: { surface, ...campaign } }, browser)
  try {
    page.document.head.append(script)
  } catch {
    state.failed = true
    state.queue = []
    state.client = disabled
    return disabled
  }
  return client
}

function send(state: State, event: Event, browser: AnalyticsWindow): void {
  if (state.failed) return
  if (!browser.umami) {
    if (state.queue.length < 20) state.queue.push(event)
    return
  }
  try {
    void Promise.resolve(browser.umami.track(event.name, event.data)).catch(() => {})
  } catch {
    // A blocked collector or third-party script failure is never an app failure.
  }
}

export function trackSignupCompleted(analytics: Analytics, result: SignupCreated): void {
  analytics.trackSignupCompleted(result)
}
