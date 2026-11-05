/** Browser-independent locale preferences and display formatting shared by both UIs. */
export const localeCodes = ['en', 'es', 'uk', 'de', 'pt'] as const
export type Locale = (typeof localeCodes)[number]
export const fallbackLocale: Locale = 'en'
export const localeStorageKey = 'eldhall.uiLocale.v1'

export const localeOptions: ReadonlyArray<{ code: Locale; name: string; intlLocale: string }> = [
  { code: 'en', name: 'English', intlLocale: 'en-US' },
  { code: 'es', name: 'Español', intlLocale: 'es-ES' },
  { code: 'uk', name: 'Українська', intlLocale: 'uk-UA' },
  { code: 'de', name: 'Deutsch', intlLocale: 'de-DE' },
  { code: 'pt', name: 'Português', intlLocale: 'pt-PT' },
]

export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())[0]
    const language = canonical?.split('-')[0]
    return localeCodes.find(code => code === canonical) ?? localeCodes.find(code => code === language)
  } catch { return undefined }
}

export interface LocalePreference {
  url?: string
  storedLocale?: unknown
  browserLanguages?: readonly string[]
  /** Only the landing page supplies an explicit localized static route. */
  routeLocale?: unknown
}

export function resolveLocale(preference: LocalePreference = {}): Locale {
  let explicit: Locale | undefined
  try {
    const values = new URL(preference.url ?? '', 'https://eldhall.invalid/').searchParams.getAll('lang')
    if (values.length === 1) explicit = normalizeLocale(values[0])
  } catch { /* Invalid input cannot make the application unavailable. */ }
  return explicit ?? normalizeLocale(preference.routeLocale) ?? normalizeLocale(preference.storedLocale)
    ?? preference.browserLanguages?.map(normalizeLocale).find((locale): locale is Locale => locale !== undefined)
    ?? fallbackLocale
}

export function detectLocale(page?: Window, routeLocale?: unknown): Locale {
  if (!page) return resolveLocale({ routeLocale })
  let storedLocale: unknown
  try { storedLocale = page.localStorage.getItem(localeStorageKey) } catch { /* Storage is optional. */ }
  return resolveLocale({
    url: page.location.href, storedLocale, routeLocale,
    browserLanguages: page.navigator.languages?.length ? page.navigator.languages : [page.navigator.language],
  })
}

export function rememberLocale(locale: Locale, page?: Window): void {
  if (!page || !localeCodes.includes(locale)) return
  try { page.localStorage.setItem(localeStorageKey, locale) } catch { /* Restricted or full storage must not break the UI. */ }
}

/** Add a validated preference to an already trusted app link; never invent a redirect. */
export function withLocale(href: string, locale: Locale, base: string): string | null {
  if (!localeCodes.includes(locale)) return null
  try {
    const target = new URL(href, base)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null
    target.searchParams.set('lang', locale)
    const relative = target.origin === new URL(base).origin && (href.startsWith('/') || href.startsWith('#') || href.startsWith('?'))
    return relative
      ? `${target.pathname}${target.search}${target.hash}` : target.href
  } catch { return null }
}

/** A locale change updates the URL without navigation, request side effects or fragment loss. */
export function updateLocaleUrl(locale: Locale, page?: Window, routePaths = false): void {
  if (!page || !localeCodes.includes(locale)) return
  try {
    const url = new URL(page.location.href)
    const route = url.pathname.replace(/^\//, '').replace(/\/$/, '')
    if (routePaths && (!route || localeCodes.some(code => code === route))) url.pathname = `/${locale}/`
    url.searchParams.set('lang', locale)
    page.history.replaceState(page.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch { /* Sandboxed/embedded history is optional; the in-memory choice still works. */ }
}

export function localeForIntl(locale: Locale): string {
  return localeOptions.find(option => option.code === locale)?.intlLocale ?? 'en-US'
}

export function formatNumber(value: number, locale: Locale, options: Intl.NumberFormatOptions = {}): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(localeForIntl(locale), options).format(value) : '—'
}

export function formatMoney(cents: number, currency: string, locale: Locale): string {
  if (!Number.isFinite(cents)) return '—'
  try { return formatNumber(cents / 100, locale, { style: 'currency', currency }) }
  catch { return `${formatNumber(cents / 100, locale)} ${currency}` }
}

function displayDate(value: string, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(localeForIntl(locale), { ...options, timeZone: 'Europe/Kyiv' }).format(date)
    : '—'
}

export function formatDateTime(value: string, locale: Locale): string {
  return displayDate(value, locale, { dateStyle: 'short', timeStyle: 'short' })
}

export function formatTime(value: string, locale: Locale): string {
  return displayDate(value, locale, { hour: '2-digit', minute: '2-digit' })
}

/** Percent input is a ratio, e.g. 0.25 for 25%; no business values are converted. */
export function formatPercent(ratio: number, locale: Locale, options: Intl.NumberFormatOptions = {}): string {
  return formatNumber(ratio, locale, { style: 'percent', maximumFractionDigits: 0, ...options })
}
