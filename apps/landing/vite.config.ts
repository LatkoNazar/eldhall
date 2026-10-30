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
      const attributes = href
        ? `href="${href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}" `
        : 'aria-disabled="true" '
      return html.replaceAll('data-app-link=', `${attributes}data-app-link=`)
    },
  }],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    fs: { allow: ['.', '../../packages/analytics'] },
  },
}))
