import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const localDemo = mode === 'local-demo'
  const inspectorDemo = mode === 'inspector-demo'
  const isolated = localDemo || inspectorDemo || mode === 'test'
  const backend = { target: inspectorDemo ? 'http://127.0.0.1:5293' : localDemo ? 'http://127.0.0.1:8000' : process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' }
  return {
  envDir: isolated ? false : '../..',
  envPrefix: isolated ? [] : ['VITE_', 'PUBLIC_'],
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'react-vendor', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    host: localDemo || inspectorDemo ? '127.0.0.1' : '0.0.0.0',
    port: inspectorDemo ? 5192 : 5173,
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
