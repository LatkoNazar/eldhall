import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next'
import { detectLocale, formatNumber, normalizeLocale, localeCodes, rememberLocale, updateLocaleUrl, type Locale } from '../../../packages/i18n/src/core.ts'
import { englishCatalog, getLoadedCatalog, loadAppCatalog, type AppMessageKey } from './locales'

export { localeCodes, localeOptions, normalizeLocale, detectLocale, withLocale, formatMoney, formatDateTime, formatTime, formatNumber, formatPercent } from '../../../packages/i18n/src/core.ts'
export type { Locale, AppMessageKey }
export type TranslationValues = Record<string, string | number>
export interface UiMessage { key: AppMessageKey; values?: TranslationValues }
export type Translate = (key: AppMessageKey, values?: TranslationValues) => string

function createEngine(locale: Locale) {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: locale, fallbackLng: 'en', supportedLngs: [...localeCodes],
    resources: { en: { translation: englishCatalog }, [locale]: { translation: getLoadedCatalog(locale) ?? englishCatalog } },
    keySeparator: false, nsSeparator: false, initAsync: false,
    interpolation: { escapeValue: false }, returnNull: false, react: { useSuspense: false },
  })
  instance.services.formatter?.add('number', (value, language) => formatNumber(Number(value), normalizeLocale(language) ?? locale))
  return instance
}
const fixedEngines = new Map<Locale, i18n>()
/** Explicit locale only: no URL/storage/window access or mutable current-language singleton. */
export function translateMessage(message: UiMessage, locale: Locale): string {
  let engine = fixedEngines.get(locale)
  if (!engine) { engine = createEngine(locale); fixedEngines.set(locale, engine) }
  return String(engine.t(message.key, message.values))
}
interface Controls { engine: i18n; locale: Locale; setLocale: (locale: Locale) => void; switchingLocale: Locale | null; languageError: UiMessage | null }
const Context = createContext<Controls | null>(null)
export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [engine] = useState(() => createEngine(initialLocale ?? detectLocale(typeof window === 'undefined' ? undefined : window)))
  const [locale, update] = useState<Locale>(() => initialLocale ?? detectLocale(typeof window === 'undefined' ? undefined : window))
  const [requests] = useState(() => new Set<symbol>())
  const [switchingLocale, setSwitching] = useState<Locale | null>(null)
  const [languageError, setLanguageError] = useState<UiMessage | null>(null)
  const setLocale = useCallback((next: Locale) => {
    if (!localeCodes.includes(next)) return
    const request = Symbol()
    requests.clear(); requests.add(request)
    setSwitching(next); setLanguageError(null)
    void loadAppCatalog(next).then(catalog => {
      if (!requests.has(request)) return
      engine.addResourceBundle(next, 'translation', catalog, true, true)
      return engine.changeLanguage(next).then(() => {
        if (!requests.has(request)) return
        update(next); setSwitching(null)
        if (typeof window !== 'undefined') { rememberLocale(next, window); updateLocaleUrl(next, window) }
      })
    }).catch(() => {
      if (requests.has(request)) { setSwitching(null); setLanguageError({ key: 'core.language.loadFailed' }) }
    })
  }, [engine, requests])
  useEffect(() => () => { requests.clear() }, [requests])
  useEffect(() => {
    rememberLocale(locale, typeof window === 'undefined' ? undefined : window)
    document.documentElement.lang = locale
    document.title = translateMessage({ key: 'core.document.title' }, locale)
    document.querySelector('meta[name="description"]')?.setAttribute('content', translateMessage({ key: 'core.document.description' }, locale))
  }, [locale])
  const value = useMemo(() => ({ engine, locale, setLocale, switchingLocale, languageError }), [engine, locale, setLocale, switchingLocale, languageError])
  return createElement(I18nextProvider, { i18n: engine }, createElement(Context.Provider, { value }, children))
}
export function useI18n() {
  const context = useContext(Context)
  if (!context) throw new Error('I18nProvider is required')
  const { t: translate } = useTranslation('translation', { i18n: context.engine })
  const t: Translate = useCallback((key, values) => String(translate(key, values)), [translate])
  const message = useCallback((value: UiMessage) => t(value.key, value.values), [t])
  return { t, locale: context.locale, setLocale: context.setLocale, translateMessage: message, switchingLocale: context.switchingLocale, languageError: context.languageError }
}
