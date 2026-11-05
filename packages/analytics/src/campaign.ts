export const campaignKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const
export type Campaign = Partial<Record<(typeof campaignKeys)[number], string>>
const storageKey = 'eldhall.acquisition.v1'
const safeCampaign = /^[\p{L}\p{N}][\p{L}\p{N} ._~+-]{0,99}$/u

function cleanCampaign(value: unknown): Campaign {
  const result: Campaign = {}
  if (!value || typeof value !== 'object') return result
  for (const key of campaignKeys) {
    const item = (value as Record<string, unknown>)[key]
    if (typeof item === 'string' && safeCampaign.test(item)) result[key] = item
  }
  return result
}

export function campaignFromUrl(value: string): Campaign {
  try {
    return cleanCampaign(Object.fromEntries(new URL(value).searchParams))
  } catch {
    return {}
  }
}

/** First campaign in this origin's browser-tab session wins. Storage is optional. */
export function acquisitionContext(page: Window = window): Campaign {
  const current = campaignFromUrl(page.location.href)
  try {
    const stored = cleanCampaign(JSON.parse(page.sessionStorage.getItem(storageKey) ?? 'null'))
    if (Object.keys(stored).length) return stored
    if (Object.keys(current).length) page.sessionStorage.setItem(storageKey, JSON.stringify(current))
  } catch {
    // Browsing restrictions and full storage must never affect the application.
  }
  return current
}

/** Resolve only a configured HTTP(S) app URL, never a redirect from the query string. */
export function appLink(appUrl: string | undefined, campaign: Campaign): string | null {
  try {
    const url = new URL(appUrl ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    for (const [key, value] of Object.entries(cleanCampaign(campaign))) url.searchParams.set(key, value)
    return url.href
  } catch {
    return null
  }
}

/** Keep campaign reporting while removing arbitrary query strings and fragments. */
export function sanitizeAnalyticsUrl(value: string, base: string): string {
  if (!value) return ''
  try {
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    const campaign = campaignFromUrl(url.href)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    for (const [key, item] of Object.entries(campaign)) url.searchParams.set(key, item)
    return value.startsWith('/') ? `${url.pathname}${url.search}` : url.href
  } catch {
    return ''
  }
}
