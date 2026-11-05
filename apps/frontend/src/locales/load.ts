import type { Locale } from '../../../../packages/i18n/src/core.ts'
import coreEn from './core/en.ts'
import operationsEn from './operations/en.ts'
import presentationEn from './presentation/en.ts'

export type AppMessageKey = keyof typeof coreEn | keyof typeof operationsEn | keyof typeof presentationEn
export type AppCatalog = Record<AppMessageKey, string>
export const englishCatalog: AppCatalog = { ...coreEn, ...operationsEn, ...presentationEn }

const loaded = new Map<Locale, AppCatalog>([['en', englishCatalog]])
const pending = new Map<Locale, Promise<AppCatalog>>()
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<AppCatalog>> = {
  es: async () => {
    const [core, operations, presentation] = await Promise.all([import('./core/es.ts'), import('./operations/es.ts'), import('./presentation/es.ts')])
    return { ...core.default, ...operations.default, ...presentation.default }
  },
  uk: async () => {
    const [core, operations, presentation] = await Promise.all([import('./core/uk.ts'), import('./operations/uk.ts'), import('./presentation/uk.ts')])
    return { ...core.default, ...operations.default, ...presentation.default }
  },
  de: async () => {
    const [core, operations, presentation] = await Promise.all([import('./core/de.ts'), import('./operations/de.ts'), import('./presentation/de.ts')])
    return { ...core.default, ...operations.default, ...presentation.default }
  },
  pt: async () => {
    const [core, operations, presentation] = await Promise.all([import('./core/pt.ts'), import('./operations/pt.ts'), import('./presentation/pt.ts')])
    return { ...core.default, ...operations.default, ...presentation.default }
  },
}

/** Local build chunks only. Failed loads are retryable and never change the active UI. */
export function loadAppCatalog(locale: Locale): Promise<AppCatalog> {
  const cached = loaded.get(locale)
  if (cached) return Promise.resolve(cached)
  const inflight = pending.get(locale)
  if (inflight) return inflight
  if (!Object.hasOwn(loaders, locale)) return Promise.reject(new RangeError('Unsupported interface locale'))
  const request = loaders[locale as Exclude<Locale, 'en'>]()
    .then(messages => { loaded.set(locale, messages); return messages })
    .finally(() => { pending.delete(locale) })
  pending.set(locale, request)
  return request
}

export function getLoadedCatalog(locale: Locale): AppCatalog | undefined {
  return loaded.get(locale)
}
