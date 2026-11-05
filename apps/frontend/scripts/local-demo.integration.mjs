import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import config from '../vite.config.ts'

test('local demo ignores ambient proxies and public variables without reading env files', async () => {
  const previous = process.env.API_PROXY_TARGET
  process.env.API_PROXY_TARGET = 'http://127.0.0.1:9'
  try {
    assert.equal(typeof config, 'function')
    const demo = await config({ command: 'serve', mode: 'local-demo' })
    assert.equal(demo.envDir, false)
    assert.deepEqual(demo.envPrefix, [])
    assert.equal(demo.server.host, '127.0.0.1')
    assert.equal(demo.server.port, 5173)
    assert.equal(demo.server.strictPort, true)
    for (const proxy of Object.values(demo.server.proxy)) assert.equal(proxy.target, 'http://127.0.0.1:8000')
    const normal = await config({ command: 'serve', mode: 'development' })
    assert.equal(normal.envDir, '../..')
    assert.deepEqual(normal.envPrefix, ['VITE_', 'PUBLIC_'])
    assert.equal(normal.server.host, '0.0.0.0')
  } finally {
    if (previous === undefined) delete process.env.API_PROXY_TARGET
    else process.env.API_PROXY_TARGET = previous
  }
})

test('demo launcher refuses host overrides before importing Vite or listening', () => {
  const script = fileURLToPath(new URL('./local-demo.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--host', '0.0.0.0'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /не приймає додаткових аргументів/)
})

test('actual frontend CLI serves only the fixed demo mode and proxies to the owned loopback fixture', { timeout: 40_000 }, async t => {
  let requests = 0
  const backend = createServer((request, response) => {
    if (request.url === '/api/v1/operator/session' && request.headers.authorization === 'Bearer 1111') requests++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ syntheticLoopbackFixture: true }))
  })
  await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(8000, '127.0.0.1', resolve) })
  t.after(async () => { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)) })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./local-demo.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', NODE_ENV: 'production', API_PROXY_TARGET: 'http://127.0.0.1:9', PUBLIC_UMAMI_SCRIPT_URL: 'https://synthetic-unwanted-tracker.example/script.js', PUBLIC_UMAMI_WEBSITE_ID: 'synthetic-unwanted-id' },
  })
  let outputBytes = 0
  let ownedReady = false
  let readyOutput = ''
  const consume = data => { outputBytes += data.length; if (outputBytes > 64_000) child.kill() }
  child.stdout.on('data', data => {
    consume(data)
    readyOutput = (readyOutput + data.toString('utf8')).slice(-1000)
    ownedReady ||= readyOutput.includes('Локальне демо: http://127.0.0.1:5173 — лише синтетичні дані.')
  })
  child.stderr.on('data', consume)
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(deadline) }
  })
  const until = Date.now() + 30_000
  let ready = false
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, 'Owned frontend exited before readiness')
    assert.equal(child.signalCode, null, 'Owned frontend stopped before readiness')
    if (!ownedReady) {
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }
    try {
      const response = await fetch('http://127.0.0.1:5173/api/v1/operator/session', { headers: { Authorization: 'Bearer 1111' }, signal: AbortSignal.timeout(1000) })
      const value = await response.json()
      if (response.ok && value.syntheticLoopbackFixture === true) { ready = true; break }
    } catch { /* Only the owned loopback endpoint is polled during startup. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, 'Fixed loopback frontend did not become ready')
  assert.ok(requests > 0, 'The fixed proxy did not reach the owned backend')
  const page = await fetch('http://127.0.0.1:5173/')
  assert.equal(page.status, 200)
  const module = await fetch('http://127.0.0.1:5173/src/main.tsx')
  const text = await module.text()
  assert.equal(module.status, 200)
  assert.ok(text.includes('local-demo'))
  assert.ok(!text.includes('synthetic-unwanted-tracker'))
  assert.ok(!text.includes('synthetic-unwanted-id'))
  assert.ok(outputBytes < 64_000)
})
