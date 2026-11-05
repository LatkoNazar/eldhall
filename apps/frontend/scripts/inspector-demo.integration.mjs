import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import config from '../vite.config.ts'
import { launchInspectorDemo, parseInspectorDemoArgs } from './inspector-demo.mjs'

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const close = server => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) })

test('inspector preview accepts only bounded loopback port options', () => {
  assert.deepEqual(parseInspectorDemoArgs([]), { port: 5192, apiPort: 5293 })
  assert.deepEqual(parseInspectorDemoArgs(['--port', '0', '--api-port', '0']), { port: 0, apiPort: 0 })
  for (const args of [['--host', '0.0.0.0'], ['--config', 'other.ts'], ['--port'], ['--port', '-1'], ['--port', '65536'], ['--port', '1e3'], ['--port', '1', '--port', '2'], ['--port', '1234', '--api-port', '1234']]) assert.throws(() => parseInspectorDemoArgs(args))
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./inspector-demo.mjs', import.meta.url)), '--host', '0.0.0.0'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 2)
  assert.equal(child.stdout, '')
  assert.match(child.stderr, /лише --port/)
})

test('inspector mode ignores ambient proxy targets and disables environment-file exposure', async () => {
  const oldTarget = process.env.API_PROXY_TARGET
  process.env.API_PROXY_TARGET = 'https://unexpected.example.invalid'
  try {
    const demo = await config({ command: 'serve', mode: 'inspector-demo' })
    assert.equal(demo.envDir, false)
    assert.deepEqual(demo.envPrefix, [])
    assert.equal(demo.server.host, '127.0.0.1')
    assert.equal(demo.server.port, 5192)
    assert.equal(demo.server.strictPort, true)
    for (const proxy of Object.values(demo.server.proxy)) assert.equal(proxy.target, 'http://127.0.0.1:5293')
    const normal = await config({ command: 'serve', mode: 'development' })
    assert.equal(normal.envDir, '../..')
    assert.equal(normal.server.proxy['^/api(?:[/?]|$)'].target, 'https://unexpected.example.invalid')
  } finally {
    if (oldTarget === undefined) delete process.env.API_PROXY_TARGET
    else process.env.API_PROXY_TARGET = oldTarget
  }
})

test('real frontend and fixture share a read-only loopback lifecycle without reaching an ambient backend', { timeout: 30_000 }, async t => {
  let unexpectedRequests = 0
  const trap = createServer((_request, response) => { unexpectedRequests++; response.end('Unexpected ambient backend') })
  await listen(trap)
  t.after(() => close(trap))
  const oldTarget = process.env.API_PROXY_TARGET
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${trap.address().port}`
  t.after(() => { if (oldTarget === undefined) delete process.env.API_PROXY_TARGET; else process.env.API_PROXY_TARGET = oldTarget })
  const demo = await launchInspectorDemo({ port: 0, apiPort: 0 })
  t.after(() => demo.close())
  assert.equal(demo.api.address().address, '127.0.0.1')
  assert.equal(demo.frontend.httpServer.address().address, '127.0.0.1')
  assert.notEqual(demo.api.address().port, demo.frontend.httpServer.address().port)
  assert.match(demo.operatorUrl, /^http:\/\/127\.0\.0\.1:\d+\/operator\?lang=uk#key=1111$/)
  const ui = await fetch(`${demo.url}/operator`, { signal: AbortSignal.timeout(5000) })
  assert.equal(ui.status, 200)
  assert.match(await ui.text(), /<div id="root"><\/div>/)
  const headers = { Authorization: 'Bearer 1111' }
  const denied = await fetch(`${demo.url}/api/v1/operator/session`, { signal: AbortSignal.timeout(5000) })
  assert.equal(denied.status, 401)
  const session = await fetch(`${demo.url}/api/v1/operator/session`, { headers, signal: AbortSignal.timeout(5000) })
  assert.deepEqual(await session.json(), { authenticated: true })
  const businesses = await fetch(`${demo.url}/api/v1/businesses`, { headers, signal: AbortSignal.timeout(5000) })
  assert.equal((await businesses.json()).businesses.length, 13)
  const cases = await fetch(`${demo.url}/api/v1/cases`, { headers, signal: AbortSignal.timeout(5000) })
  assert.equal((await cases.json()).length, 13)
  const write = await fetch(`${demo.url}/api/v1/proposals/synthetic/approve`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000) })
  assert.equal(write.status, 405)
  assert.equal(unexpectedRequests, 0)
  await demo.close()
  await demo.close()
  await assert.rejects(fetch(`${demo.apiUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
  await assert.rejects(fetch(`${demo.url}/operator`, { signal: AbortSignal.timeout(1000) }))
})

test('a frontend port conflict closes the newly owned fixture without disturbing its owner', { timeout: 30_000 }, async t => {
  const occupied = createServer((_request, response) => response.end('Original listener'))
  await listen(occupied)
  t.after(() => close(occupied))
  const reservation = createServer()
  await listen(reservation)
  const apiPort = reservation.address().port
  await close(reservation)
  await assert.rejects(launchInspectorDemo({ port: occupied.address().port, apiPort }))
  const existing = await fetch(`http://127.0.0.1:${occupied.address().port}`, { signal: AbortSignal.timeout(1000) })
  assert.equal(await existing.text(), 'Original listener')
  const reused = createServer()
  await new Promise((resolve, reject) => { reused.once('error', reject); reused.listen(apiPort, '127.0.0.1', resolve) })
  await close(reused)
})
