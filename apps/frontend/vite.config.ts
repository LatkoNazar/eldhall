import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const backend = {
  target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000',
}

export default defineConfig({
  envDir: '../..',
  envPrefix: ['VITE_', 'PUBLIC_'],
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    fs: { allow: ['.', '../../packages/analytics'] },
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
})
