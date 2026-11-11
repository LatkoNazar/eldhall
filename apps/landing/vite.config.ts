import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { landingLocalization } from './scripts/i18n-plugin.ts'

const envDirectory = fileURLToPath(new URL('../..', import.meta.url))
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDirectory, 'PUBLIC_')
  return {
    envDir: envDirectory,
    envPrefix: ['VITE_', 'PUBLIC_'],
    appType: 'mpa',
    plugins: [landingLocalization(env.PUBLIC_APP_URL, env.PUBLIC_LANDING_URL)],
    server: {
      host: '0.0.0.0',
      port: 5174,
      strictPort: true,
      fs: { allow: ['.', '../../packages/analytics', '../../packages/i18n'] },
    },
  }
})
