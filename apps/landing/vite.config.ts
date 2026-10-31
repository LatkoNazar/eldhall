import { defineConfig, loadEnv } from 'vite'
import { appLink } from '../../packages/analytics/src/index.ts'

export default defineConfig(({ mode }) => ({
  envDir: '../..',
  envPrefix: ['VITE_', 'PUBLIC_'],
  appType: 'mpa',
  plugins: [{
    name: 'eldhall-static-app-links',
    transformIndexHtml(html) {
      const env = loadEnv(mode, '../..', 'PUBLIC_')
      const href = appLink(env.PUBLIC_APP_URL, {})
      // CTAs ship with href="#scenario" (the on-page walkthrough); a configured app URL replaces it.
      if (!href) return html
      const escaped = href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      return html.replaceAll('href="#scenario" data-app-link=', `href="${escaped}" data-app-link=`)
    },
  }],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    fs: { allow: ['.', '../../packages/analytics'] },
  },
}))
