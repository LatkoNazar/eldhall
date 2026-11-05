export interface OperatorLink { key?: string; error?: 'invalid' | 'unscrubbed' }
const listeners = new Set<(link: OperatorLink) => void>()

export function publishOperatorLink(link: OperatorLink) {
  if (link.key !== undefined || link.error !== undefined) listeners.forEach(listener => listener(link))
}

function fragmentKeys(raw: string) {
  return raw.split('&').filter(part => {
    try { return decodeURIComponent(part.split('=')[0] ?? '') === 'key' } catch { return false }
  })
}
function onCredentialEntry() { publishOperatorLink(consumeOperatorLink()) }
export function subscribeOperatorLinks(listener: (link: OperatorLink) => void) {
  if (!listeners.size) {
    // Scrub before ordinary application navigation reads the new location.
    // Analytics separately excludes hashes and sanitizes every outgoing URL.
    window.addEventListener('hashchange', onCredentialEntry, true)
    window.addEventListener('popstate', onCredentialEntry, true)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      window.removeEventListener('hashchange', onCredentialEntry, true)
      window.removeEventListener('popstate', onCredentialEntry, true)
    }
  }
}

function parseCandidate(raw: string, pathname: string, keys: string[]): OperatorLink {
  if (pathname.replace(/\/+$/, '') === '/chat') return {}
  if (raw.length > 16_384 || keys.length !== 1) return { error: 'invalid' }
  try {
    const part = keys[0]!
    const separator = part.indexOf('=')
    const key = separator < 0 ? '' : decodeURIComponent(part.slice(separator + 1))
    return key.length > 0 && key.length <= 4096 && !/\s/.test(key) ? { key } : { error: 'invalid' }
  } catch { return { error: 'invalid' } }
}

export function sanitizedOperatorDestination(target: URL) {
  const raw = target.hash.slice(1)
  const keys = fragmentKeys(raw)
  const link = keys.length ? parseCandidate(raw, target.pathname, keys) : {}
  return { destination: target.pathname + target.search + (keys.length ? '' : target.hash), link }
}

export function consumeOperatorLink(): OperatorLink {
  const raw = window.location.hash.slice(1)
  if (!raw) return {}
  const keys = fragmentKeys(raw)
  if (!keys.length) return {}
  // Scrub first, before validation, storage, rendering or analytics. Never use
  // a URL supplied by the fragment as a redirect/history destination.
  try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search) }
  catch { return { error: 'unscrubbed' } }
  return parseCandidate(raw, window.location.pathname, keys)
}
