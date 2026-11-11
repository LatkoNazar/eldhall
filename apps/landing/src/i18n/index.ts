import { createInstance } from 'i18next'
import { localeCodes, type Locale } from '../../../../packages/i18n/src/core.ts'
import english from './locales/en.ts'
import type { Catalog, MessageKey } from './keys.ts'
import { landingStructuredData } from '../structured-data.ts'
export type { Catalog, MessageKey } from './keys.ts'

const loaded = new Map<Locale, Catalog>([['en', english]])
const pending = new Map<Locale, Promise<Readonly<Catalog>>>()
const loaders = {
  en: () => Promise.resolve({ default: english }),
  es: () => import('./locales/es.ts'),
  uk: () => import('./locales/uk.ts'),
  de: () => import('./locales/de.ts'),
  pt: () => import('./locales/pt.ts'),
} satisfies Record<Locale, () => Promise<{ default: Catalog }>>

// All resources are bundled. No backend, detector, browser read or network plugin.
const engine = createInstance()
void engine.init({
  lng: 'en', fallbackLng: 'en', supportedLngs: [...localeCodes],
  ns: ['landing'], defaultNS: 'landing', keySeparator: false,
  resources: { en: { landing: english } },
  initAsync: false, returnNull: false, returnEmptyString: false,
  interpolation: { escapeValue: false },
})

export function isMessageKey(value: string): value is MessageKey { return Object.hasOwn(english, value) }

/** Only the selected locale chunk and bundled English fallback are needed by a browser. */
export function loadLocale(locale: Locale): Promise<Readonly<Catalog>> {
  const cached = loaded.get(locale)
  if (cached) return Promise.resolve(cached)
  const existing = pending.get(locale)
  if (existing) return existing
  const request = loaders[locale]().then(({ default: catalog }) => {
    if (Object.keys(english).some(key => typeof catalog[key as MessageKey] !== 'string' || !catalog[key as MessageKey])) throw new Error('Incomplete landing locale')
    engine.addResourceBundle(locale, 'landing', catalog)
    loaded.set(locale, catalog)
    return catalog
  }).finally(() => pending.delete(locale))
  pending.set(locale, request)
  return request
}

export function translate(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  return engine.t(key, { ...values, lng: locale, ns: 'landing' })
}

export const translatedAttributes = ['aria-label', 'alt', 'content'] as const

/** Bind authored semantic keys only. Never interpret translated text as markup. */
export function applyLandingLocale(root: Document, locale: Locale): void {
  root.documentElement.lang = locale
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n ?? ''
    if (!isMessageKey(key)) throw new Error('Unknown landing text binding')
    element.textContent = translate(locale, key)
  }
  for (const attribute of translatedAttributes) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      const key = element.getAttribute(`data-i18n-${attribute}`) ?? ''
      if (!isMessageKey(key)) throw new Error('Unknown landing attribute binding')
      element.setAttribute(attribute, translate(locale, key))
    }
  }
  for (const picker of root.querySelectorAll<HTMLSelectElement>('[data-language-picker]')) picker.value = locale
  const schema = root.querySelector<HTMLScriptElement>('script[data-landing-schema]')
  if (schema?.dataset.siteUrl && schema.dataset.pageUrl) {
    schema.textContent = landingStructuredData(schema.dataset.siteUrl, schema.dataset.pageUrl, locale, root.title, translate(locale, 'hero.lead'))
  }
}
