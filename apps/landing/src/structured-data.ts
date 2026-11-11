import type { Locale } from '../../../packages/i18n/src/core.ts'

export function landingOrigin(configuredUrl?: string): string | undefined {
  if (!configuredUrl) return
  try {
    const url = new URL(configuredUrl)
    if (url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) {
      return url.origin
    }
  } catch {
    // A missing or invalid origin must not generate misleading public URLs.
  }
}

export function landingPageUrl(origin: string, locale: Locale): string {
  return new URL(locale === 'en' ? '/' : `/${locale}/`, origin).href
}

export function landingStructuredData(siteUrl: string, pageUrl: string, locale: Locale, title: string, description: string): string {
  const siteId = `${siteUrl}#website`
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': siteId, url: siteUrl, name: 'Eldhall' },
      {
        '@type': 'WebPage', '@id': `${pageUrl}#webpage`, url: pageUrl, name: title,
        description, inLanguage: locale, isPartOf: { '@id': siteId },
      },
    ],
  }).replace(/</g, '\\u003c')
}
