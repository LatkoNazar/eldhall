import { detectLocale, normalizeLocale, rememberLocale, updateLocaleUrl, type Locale } from '../../../packages/i18n/src/core.ts'
import { applyLandingLocale, loadLocale, translate } from './i18n/index.ts'

type LoadLocale = (locale: Locale) => Promise<unknown>
/** A failed or superseded chunk never replaces the current page or remembered preference. */
export function initLandingLanguage(root: Document, page: Window, onApply: (locale: Locale) => void, load: LoadLocale = loadLocale) {
  let current = normalizeLocale(root.documentElement.lang) ?? 'en'
  let generation = 0
  let disposed = false
  const pickers = [...root.querySelectorAll<HTMLSelectElement>('[data-language-picker]')]
  const statuses = [...root.querySelectorAll<HTMLElement>('[data-language-status]')]
  const change = async (locale: Locale, explicit: boolean) => {
    const attempt = ++generation
    pickers.forEach(picker => { picker.value = current; picker.setAttribute('aria-busy', 'true') })
    statuses.forEach(status => { status.textContent = '' })
    try {
      await load(locale)
      if (disposed || generation !== attempt) return
      applyLandingLocale(root, locale)
      onApply(locale)
      current = locale
      rememberLocale(locale, page)
      if (explicit) updateLocaleUrl(locale, page, true)
    } catch {
      if (disposed || generation !== attempt) return
      statuses.forEach(status => { status.textContent = translate(current, 'languageError') })
      pickers.forEach(picker => { picker.value = current })
    } finally {
      if (!disposed && generation === attempt) pickers.forEach(picker => picker.removeAttribute('aria-busy'))
    }
  }
  const listener = (event: Event) => {
    const locale = normalizeLocale((event.currentTarget as HTMLSelectElement).value)
    if (locale) void change(locale, true)
  }
  pickers.forEach(picker => picker.addEventListener('change', listener))
  const routeLocale = normalizeLocale(page.location.pathname.split('/')[1])
  return {
    ready: change(detectLocale(page, routeLocale), false),
    destroy() { disposed = true; generation++; pickers.forEach(picker => picker.removeEventListener('change', listener)) },
  }
}
