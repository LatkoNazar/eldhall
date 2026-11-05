import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { landingLocalization } from './scripts/i18n-plugin.ts'

const envDirectory = fileURLToPath(new URL('../..', import.meta.url))
export default defineConfig(({ mode }) => ({
  envDir: envDirectory,
  envPrefix: ['VITE_', 'PUBLIC_'],
  appType: 'mpa',
  plugins: [landingLocalization(loadEnv(mode, envDirectory, 'PUBLIC_').PUBLIC_APP_URL)],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    fs: { allow: ['.', '../../packages/analytics', '../../packages/i18n'] },
  },
}))
