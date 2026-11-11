import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { localeCodes, normalizeLocale } from '../../../packages/i18n/src/core.ts'
import { renderLanding } from './i18n-render.ts'

export function landingLocalization(configuredAppUrl?: string, configuredLandingUrl?: string): Plugin {
  return {
    name: 'eldhall-localized-html',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(source, context) {
        const route = normalizeLocale(context.path.split('/')[1]) ?? 'en'
        return renderLanding(source, route, configuredAppUrl, configuredLandingUrl)
      },
    },
    configureServer(server) {
      // Locale directories also work in development without maintaining five source documents.
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!localeCodes.some(locale => pathname === `/${locale}/` || pathname === `/${locale}/index.html`)) return next()
        try {
          const source = await readFile(resolve(server.config.root, 'index.html'), 'utf8')
          const rendered = await server.transformIndexHtml(pathname, source)
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(rendered)
        } catch (error) { next(error) }
      })
    },
    async generateBundle(_options, bundle) {
      const entry = bundle['index.html']
      if (!entry || entry.type !== 'asset' || typeof entry.source !== 'string') throw new Error('Missing landing HTML build entry')
      const source = entry.source
      entry.source = await renderLanding(source, 'en', configuredAppUrl, configuredLandingUrl)
      for (const locale of localeCodes) this.emitFile({
        type: 'asset',
        fileName: `${locale}/index.html`,
        source: await renderLanding(source, locale, configuredAppUrl, configuredLandingUrl),
      })
    },
  }
}
