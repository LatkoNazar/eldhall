import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const defaults = { port: 5192, apiPort: 5293 }
const validPort = value => Number.isInteger(value) && value >= 0 && value <= 65535

export function parseInspectorDemoArgs(args) {
  const options = { ...defaults }
  const seen = new Set()
  if (args.length === 1 && args[0] === '--help') return { help: true }
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    if (!['--port', '--api-port'].includes(flag) || seen.has(flag) || !/^\d{1,5}$/.test(args[i + 1] ?? '')) throw new Error('Expected only --port and --api-port with valid integer ports')
    seen.add(flag)
    const value = Number(args[i + 1])
    if (!validPort(value)) throw new Error('Invalid demo port')
    options[flag === '--port' ? 'port' : 'apiPort'] = value
  }
  if (options.port !== 0 && options.port === options.apiPort) throw new Error('Frontend and API ports must differ')
  return options
}

/** Source-only, read-only presentation preview. Both listeners share this process. */
export async function launchInspectorDemo(options = {}) {
  if (Object.keys(options).some(key => !Object.hasOwn(defaults, key))) throw new Error('Demo accepts port options only')
  const { port, apiPort } = { ...defaults, ...options }
  if (!validPort(port) || !validPort(apiPort) || (port !== 0 && port === apiPort)) throw new Error('Invalid demo ports')
  let api
  let frontend
  let closing
  const close = () => {
    closing ??= (async () => {
      const results = await Promise.allSettled([
        frontend?.close(),
        api && new Promise((resolve, reject) => {
          api.closeAllConnections()
          api.close(error => error ? reject(error) : resolve())
        }),
      ])
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    })()
    return closing
  }
  try {
    const [{ createServer }, { startInspectorDemo }] = await Promise.all([
      import('vite'),
      import('../../../scripts/inspector-demo.mjs'),
    ])
    api = await startInspectorDemo({ port: apiPort })
    const apiAddress = api.address()
    if (!apiAddress || typeof apiAddress === 'string' || apiAddress.address !== '127.0.0.1') throw new Error('Demo API must bind IPv4 loopback')
    const apiUrl = `http://127.0.0.1:${apiAddress.port}`
    const proxy = { target: apiUrl }
    frontend = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      mode: 'inspector-demo', envDir: false, envPrefix: [], clearScreen: false,
      server: {
        host: '127.0.0.1', port, strictPort: true,
        proxy: { '^/api(?:[/?]|$)': proxy, '^/health(?:[/?]|$)': proxy },
      },
    })
    await frontend.listen()
    const frontendAddress = frontend.httpServer?.address()
    if (!frontendAddress || typeof frontendAddress === 'string' || frontendAddress.address !== '127.0.0.1') throw new Error('Demo UI must bind IPv4 loopback')
    const url = `http://127.0.0.1:${frontendAddress.port}`
    return { api, frontend, apiUrl, url, operatorUrl: `${url}/operator?lang=uk#key=1111`, close }
  } catch (error) {
    await close()
    throw error
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args
  try { args = parseInspectorDemoArgs(process.argv.slice(2)) } catch {
    console.error('Демо приймає лише --port та --api-port. Зовнішній host чи конфігурацію задати не можна.')
    process.exitCode = 2
  }
  if (args?.help) console.log('Read-only inspector demo: --port 5192 --api-port 5293. Both listeners bind 127.0.0.1; no database or provider is used.')
  else if (args) {
    process.env.NODE_ENV = 'development'
    try {
      const demo = await launchInspectorDemo(args)
      console.log(`Демо бізнес-шаблонів · лише перегляд: ${demo.operatorUrl}`)
      const stop = async () => {
        try { await demo.close(); process.exitCode = 0 } catch { process.exitCode = 1 }
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    } catch {
      console.error('Не вдалося запустити ізольоване демо. Перевірте залежності та вільні локальні порти.')
      process.exitCode = 1
    }
  }
}
