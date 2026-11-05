import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const localDemo = mode === 'local-demo'
  const isolated = localDemo || mode === 'test'
  const backend = { target: localDemo ? 'http://127.0.0.1:8000' : process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' }
  return {
  envDir: isolated ? false : '../..',
  envPrefix: isolated ? [] : ['VITE_', 'PUBLIC_'],
  plugins: [react()],
  server: {
    host: localDemo ? '127.0.0.1' : '0.0.0.0',
    port: 5173,
    strictPort: true,
    fs: { allow: ['.', '../../packages/analytics', '../../packages/i18n'] },
    proxy: {
      '^/api(?:[/?]|$)': backend,
      '^/health(?:[/?]|$)': backend,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    clearMocks: true,
    restoreMocks: true,
  },
  }
})
