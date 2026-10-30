/**
 * Real Umami 3.4.1 API smoke, Node 22+, zero dependencies.
 * Run ONLY against an isolated test instance. Every run creates and retains a
 * uniquely named .invalid website, never uses an existing/production website,
 * and emits synthetic pageview + landing/app events (never signup_completed).
 *
 * Host: UMAMI_SMOKE_BASE_URL=http://127.0.0.1:22003
 * Container: default http://127.0.0.1:3000
 * UMAMI_SMOKE_USERNAME / UMAMI_SMOKE_PASSWORD optionally replace test credentials.
 * Using admin/umami requires UMAMI_SMOKE_ALLOW_DEFAULT_CREDENTIALS=1 explicitly.
 * Website UUID/hostname are public and printed for subsequent browser QA; auth
 * credentials and collector cache/Bearer tokens are never logged.
 *
 * API contract verified against official versioned source:
 * https://github.com/umami-software/umami/tree/v3.4.1/src/app/api
 * /auth/login, /websites, /send, /websites/[websiteId]/metrics
 * Native utmSource metrics exclude custom events, so the unnamed pageview is
 * intentional: its URL, rather than event properties, must populate that report.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const deadline = Date.now() + 90_000
const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function smokeOrigin() {
  let url
  try {
    url = new URL(process.env.UMAMI_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000')
  } catch {
    throw new Error('UMAMI_SMOKE_BASE_URL must be a valid local HTTP(S) origin.')
  }
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', 'UMAMI_SMOKE_BASE_URL must be a local HTTP(S) origin without credentials, query or path.')
  assert(['localhost', '127.0.0.1', '[::1]', 'umami'].includes(url.hostname),
    'Smoke accepts only loopback or the Docker service hostname umami; production hosts are intentionally unsupported.')
  return url.origin
}

async function main() {
  const base = smokeOrigin()
  const username = process.env.UMAMI_SMOKE_USERNAME ?? 'admin'
  const password = process.env.UMAMI_SMOKE_PASSWORD ?? 'umami'
  assert(username && password, 'Smoke test credentials cannot be empty.')
  assert(!(username === 'admin' && password === 'umami') || process.env.UMAMI_SMOKE_ALLOW_DEFAULT_CREDENTIALS === '1',
    'Default test credentials require UMAMI_SMOKE_ALLOW_DEFAULT_CREDENTIALS=1 on an isolated instance.')
  let token

  async function request(path, { method = 'GET', body, authenticated = false, cache } = {}) {
    const remaining = deadline - Date.now()
    assert(remaining > 0, 'Umami smoke exceeded its 90-second deadline.')
    const headers = { Accept: 'application/json', 'User-Agent': userAgent }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (authenticated) headers.Authorization = `Bearer ${token}`
    if (cache) headers['x-umami-cache'] = cache
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, remaining)),
      })
    } catch {
      throw new Error(`${method} ${path.split('?')[0]} failed or timed out.`)
    }
    assert(response.ok, `${method} ${path.split('?')[0]} returned HTTP ${response.status}.`)
    try {
      return await response.json()
    } catch {
      throw new Error(`${method} ${path.split('?')[0]} did not return JSON.`)
    }
  }

  const health = await request('/api/heartbeat')
  assert(health?.ok === true, 'Umami heartbeat was not healthy.')
  const login = await request('/api/auth/login', { method: 'POST', body: { username, password } })
  assert(typeof login?.token === 'string' && login.token.length > 0,
    'Test login did not return a Bearer token; use an isolated test account without 2FA.')
  token = login.token

  const hostname = `eldhall-smoke-${randomUUID().slice(0, 8)}.invalid`
  const site = await request('/api/websites', {
    method: 'POST', authenticated: true,
    body: { name: `Eldhall isolated smoke ${hostname}`, domain: hostname },
  })
  assert(uuidPattern.test(site?.id ?? ''), 'Website creation did not return a UUID.')
  const websiteId = site.id
  console.log(`UMAMI_SMOKE_WEBSITE_ID=${websiteId}`)
  console.log(`UMAMI_SMOKE_HOSTNAME=${hostname}`)

  const campaign = {
    utm_source: 'ci-smoke', utm_medium: 'integration', utm_campaign: 'eldhall-foundation',
    utm_content: 'hero', utm_term: 'mvp',
  }
  const query = new URLSearchParams(campaign).toString()
  const expected = ['landing_viewed', 'landing_cta_clicked', 'app_opened']
  const startedAt = Date.now() - 60_000
  let cache
  let sessionId
  for (const name of [undefined, ...expected]) {
    const surface = name === 'app_opened' ? 'app' : 'landing'
    const eventHostname = surface === 'app' ? `app.${hostname}` : hostname
    const sent = await request('/api/send', {
      method: 'POST', cache,
      body: {
        type: 'event',
        payload: {
          website: websiteId, hostname: eventHostname,
          url: `https://${eventHostname}/?${query}`,
          referrer: surface === 'app' ? `https://${hostname}/?${query}` : '',
          screen: '1440x900', language: 'uk-UA', title: 'Eldhall isolated smoke',
          ...(name ? { name, data: { surface, ...campaign, ...(name === 'landing_cta_clicked' ? { location: 'hero' } : {}) } } : {}),
        },
      },
    })
    assert(typeof sent?.cache === 'string' && uuidPattern.test(sent?.sessionId ?? '') && uuidPattern.test(sent?.visitId ?? ''),
      'Collector did not acknowledge a stored event; check bot filtering and the test database.')
    if (sessionId) assert(sent.sessionId === sessionId, 'Synthetic same-browser journey changed its anonymous session unexpectedly.')
    sessionId = sent.sessionId
    cache = sent.cache
  }

  let lastFailure = 'Read API has not returned all expected metrics.'
  while (Date.now() < deadline) {
    try {
      const range = new URLSearchParams({ startAt: String(startedAt), endAt: String(Date.now() + 60_000) })
      const [events, sources] = await Promise.all([
        request(`/api/websites/${websiteId}/metrics?${range}&type=event`, { authenticated: true }),
        request(`/api/websites/${websiteId}/metrics?${range}&type=utmSource`, { authenticated: true }),
      ])
      assert(Array.isArray(events) && Array.isArray(sources), 'Metrics response shape was not an array.')
      const missing = expected.filter(name => !events.some(row => row?.x === name && Number(row.y) >= 1))
      assert(missing.length === 0, `Missing persisted event metrics: ${missing.join(', ')}.`)
      assert(sources.some(row => row?.x === campaign.utm_source && Number(row.y) >= 1), 'Missing native URL-derived utmSource metric.')
      assert(!events.some(row => row?.x === 'signup_completed'), 'An unrequested signup conversion appeared in the isolated website.')
      console.log('PASS Umami persisted landing_viewed → landing_cta_clicked → app_opened and native UTM source ci-smoke.')
      console.log('Synthetic website retained for browser QA; remove it with the isolated test database when finished.')
      return
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'Metrics verification failed.'
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(1_000, remaining))
  }
  throw new Error(lastFailure)
}

try {
  await main()
} catch (error) {
  console.error(`FAIL Umami smoke: ${error instanceof Error ? error.message : 'Unknown failure.'}`)
  process.exitCode = 1
}
