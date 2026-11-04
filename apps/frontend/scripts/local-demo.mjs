// Only the explicit loopback preview; no CLI/configuration overrides.
import { fileURLToPath } from 'node:url'

if (process.argv.length !== 2) {
  console.error('Локальне демо не приймає додаткових аргументів.')
  process.exitCode = 2
} else {
  process.env.NODE_ENV = 'development'
  let server
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      mode: 'local-demo', envDir: false, envPrefix: [],
      server: { host: '127.0.0.1', port: 5173, strictPort: true },
    })
    await server.listen()
    console.log('Локальне демо: http://127.0.0.1:5173 — лише синтетичні дані.')
    const close = async () => { await server.close(); process.exitCode = 0 }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  } catch {
    await server?.close()
    console.error('Не вдалося запустити локальне демо. Перевірте, чи вільний порт 5173.')
    process.exitCode = 1
  }
}
