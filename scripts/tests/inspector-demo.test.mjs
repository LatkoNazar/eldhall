import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInspectorDemoServer, fixtureArgsHash, inspectorDemoHost, inspectorTemplateIds, loadInspectorFixtures, parseInspectorDemoArgs, startInspectorDemo } from '../inspector-demo.mjs'

const auth = { Authorization: 'Bearer 1111' }
const fixedNow = Date.parse('2030-02-03T09:00:00Z')
async function api(t) {
  const server = await startInspectorDemo({ port: 0, now: fixedNow })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, get: (path, options = {}) => fetch(base + path, { headers: auth, ...options }) }
}

test('version1 covers all12 reviewed templates plus generic with diverse scoped fictional businesses', async () => {
  const fixture = await loadInspectorFixtures()
  assert.equal(fixture.fixtureFormat, 1)
  assert.deepEqual(fixture.scenarios.map(s => s.id), [...inspectorTemplateIds, 'generic'])
  for (const property of ['id', 'name']) assert.equal(new Set(fixture.scenarios.map(s => s.business[property])).size, 13)
  assert.equal(new Set(fixture.scenarios.map(s => s.detail.customer.name)).size, 13)
  for (const id of [s => s.detail.case.id, s => s.detail.customer.id, s => s.detail.proposals[0].id]) assert.equal(new Set(fixture.scenarios.map(id)).size, 13)
  assert.ok(Object.isFrozen(fixture.scenarios[0].detail))
  assert.equal(fixture.scenarios.filter(s => s.detail.payments.length).map(s => s.id).join(), 'payments')
  for (const { business, detail } of fixture.scenarios) {
    const proposal = detail.proposals[0]
    assert.equal(detail.case.businessId, business.id)
    assert.equal(detail.customer.businessId, business.id)
    assert.equal(detail.case.customerId, detail.customer.id)
    const intents = ['duplicate_charge', 'refund_request', 'billing_question', 'cancel_subscription', 'complaint', 'other']
    assert.ok(intents.includes(detail.case.intent))
    assert.equal(detail.case.analysis.intent, detail.case.intent)
    assert.equal(detail.case.intent, detail.proposals[0].args.tags[0] === 'eldhall.ui.payments' ? 'duplicate_charge' : detail.proposals[0].args.tags[0] === 'eldhall.ui.escalation' ? 'complaint' : 'other')
    assert.ok(['low', 'medium', 'high'].includes(detail.case.analysis.sentiment.urgency))
    assert.equal(typeof detail.case.analysis.sentiment.abusive, 'boolean')
    assert.ok(['open', 'awaiting_approval', 'escalated', 'resolved'].includes(detail.case.status))
    assert.ok(['P1', 'P2', 'P3'].includes(detail.case.priority))
    assert.equal(detail.case.analysis.priority, detail.case.priority)
    assert.ok(['bot', 'staff'].includes(detail.case.ownership))
    assert.ok(['neutral', 'empathetic', 'de-escalating'].includes(detail.case.analysis.tone))
    assert.ok(['llm', 'fallback'].includes(detail.case.analysis.source))
    assert.ok(['calm', 'frustrated', 'angry', 'abusive'].includes(detail.case.analysis.sentiment.label))
    for (const message of detail.messages) assert.ok(['customer', 'assistant', 'operator', 'system'].includes(message.role))
    for (const action of detail.proposals) {
      assert.ok(['pending', 'approved', 'executing', 'executed', 'rejected', 'failed', 'denied', 'unknown', 'expired', 'invalidated'].includes(action.status))
      assert.ok(['low', 'high'].includes(action.risk))
    }
    for (const payment of detail.payments) assert.equal(payment.customerId, detail.customer.id)
    for (const event of detail.audit) assert.equal(event.caseId, detail.case.id)
    assert.equal(proposal.caseId, detail.case.id)
    for (const [key, value] of [['businessId', business.id], ['caseId', detail.case.id], ['customerId', detail.customer.id]]) assert.equal(proposal.args[key], value)
    assert.equal(proposal.argsHash, fixtureArgsHash(proposal.caseId, proposal.tool, proposal.args))
    assert.match(detail.customer.email, /@example\.invalid$/)
    assert.equal(detail.runs.length, 0, 'Do not invent executed read observations/model runs')
  }
})

test('requested input and recorded execution results stay distinct across pending, approved and ambiguous outcomes', async () => {
  const fixture = await loadInspectorFixtures()
  const states = new Set()
  for (const { id, detail } of fixture.scenarios) {
    const proposal = detail.proposals[0]
    states.add(proposal.status)
    assert.equal(proposal.tool, 'external_action')
    assert.equal(proposal.args.effect, 'write')
    assert.equal(proposal.args.input.status.endsWith('_requested') || id === 'account', true)
    if (proposal.status === 'executed') {
      assert.equal(proposal.result.status, 'executed')
      assert.ok(proposal.result.data && !Array.isArray(proposal.result.data))
      assert.notEqual(proposal.result.data.status, proposal.args.input.status)
    } else assert.equal(proposal.result?.data, undefined, `${id} must not claim a confirmed result`)
    if (['pending', 'approved'].includes(proposal.status)) assert.equal(proposal.result, null)
    if (id !== 'payments') { assert.deepEqual(detail.payments, []); assert.deepEqual(detail.refunds, []) }
  }
  for (const status of ['pending', 'approved', 'executed', 'unknown', 'failed', 'expired', 'rejected', 'invalidated']) assert.ok(states.has(status))
})

test('template fixtures use only agreed flat domain fields and unknown tagging keeps the generic fallback', async () => {
  const expected = {
    payments: ['payment_id', 'transaction_id', 'amount_cents', 'currency', 'status'], delivery: ['shipment_id', 'tracking_number', 'carrier', 'delivery_date', 'status'],
    orders: ['order_id', 'order_number', 'item_count', 'status'], returns: ['return_id', 'order_id', 'reason', 'status'],
    booking: ['booking_id', 'starts_at', 'ends_at', 'guest_count', 'status'], appointments: ['appointment_id', 'service_name', 'starts_at', 'specialist', 'status'],
    subscription: ['subscription_id', 'plan_name', 'effective_at', 'status'], account: ['account_id', 'contact_email', 'requested_change', 'status'],
    access: ['user_id', 'resource_id', 'role', 'expires_at', 'status'], incident: ['incident_id', 'service_name', 'severity', 'impact', 'status'],
    warranty: ['claim_id', 'product_id', 'serial_number', 'issue', 'status'], escalation: ['ticket_id', 'team', 'reason', 'priority', 'status'],
  }
  for (const scenario of (await loadInspectorFixtures()).scenarios) {
    const proposal = scenario.detail.proposals[0]
    if (scenario.id === 'generic') { assert.deepEqual(proposal.args.tags, ['eldhall.ui.custom-request']); continue }
    assert.deepEqual(proposal.args.tags, [`eldhall.ui.${scenario.id}`])
    for (const object of [proposal.args.input, proposal.result?.data].filter(Boolean)) {
      assert.ok(Object.keys(object).every(key => expected[scenario.id].includes(key)))
      assert.ok(Object.values(object).every(value => ['string', 'number', 'boolean'].includes(typeof value)))
      if (scenario.id !== 'payments') assert.ok(!Object.keys(object).some(key => /payment|amount|currency/i.test(key)))
    }
  }
})

test('imports do not listen and actual API binds only loopback with authenticated no-store DTOs', async t => {
  const idle = await createInspectorDemoServer({ now: fixedNow })
  assert.equal(idle.listening, false)
  const { server, get } = await api(t)
  assert.equal(server.address().address, inspectorDemoHost)
  const health = await get('/health/ready', { headers: {} })
  assert.deepEqual(await health.json(), { status: 'ok', mode: 'inspector-demo', persistence: 'none', readOnly: true })
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer 1111-extra' }]) {
    const response = await get('/api/v1/cases', { headers })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  }
  const session = await get('/api/v1/operator/session')
  assert.deepEqual(await session.json(), { authenticated: true })
  assert.equal(session.headers.get('cache-control'), 'no-store')
  assert.equal(session.headers.get('access-control-allow-origin'), null)
  const cases = await (await get('/api/v1/cases')).json()
  assert.equal(cases.length, 13)
  const detail = await (await get(`/api/v1/cases/${cases[0].id}`)).json()
  assert.equal(Date.parse(detail.case.createdAt), fixedNow)
  assert.equal(Date.parse(detail.proposals[0].args.expiresAt), fixedNow + 30 * 60_000)
  assert.equal(detail.proposals[0].argsHash, fixtureArgsHash(detail.case.id, detail.proposals[0].tool, detail.proposals[0].args))
})

test('business filtering scopes case detail and metrics without cross-business fallback', async t => {
  const { get } = await api(t)
  const { businesses } = await (await get('/api/v1/businesses')).json()
  const cases = await (await get(`/api/v1/cases?businessId=${businesses[1].id}`)).json()
  assert.equal(cases.length, 1)
  assert.equal(cases[0].businessId, businesses[1].id)
  const metrics = await (await get(`/api/v1/metrics?businessId=${businesses[1].id}`)).json()
  assert.equal(metrics.cases, 1)
  assert.equal(metrics.proposals.approved, 1)
  assert.equal(metrics.agentRuns, 0)
  assert.equal((await get(`/api/v1/cases/${cases[0].id}?businessId=${businesses[0].id}`)).status, 404)
  assert.equal((await get('/api/v1/cases?businessId=unknown')).status, 404)
  assert.equal((await get(`/api/v1/cases?businessId=${businesses[0].id}&businessId=${businesses[1].id}`)).status, 422)
})

test('every business mutation is405 and leaves snapshots/metrics unchanged', async t => {
  const { get } = await api(t)
  const before = await (await get('/api/v1/cases')).json()
  const detailBefore = await (await get(`/api/v1/cases/${before[0].id}`)).json()
  const proposal = detailBefore.proposals[0]
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const path of [`/api/v1/proposals/${proposal.id}/approve`, `/api/v1/proposals/${proposal.id}/execute`, `/api/v1/proposals/${proposal.id}/reconcile`, `/api/v1/cases/${before[0].id}/messages`, `/api/v1/cases/${before[0].id}/takeover`, '/api/v1/settings', '/api/v1/reset']) {
      const response = await get(path, { method, body: method === 'OPTIONS' ? undefined : JSON.stringify({ argsHash: proposal.argsHash }) })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'GET')
    }
  }
  assert.deepEqual(await (await get(`/api/v1/cases/${before[0].id}`)).json(), detailBefore)
  assert.deepEqual(await (await get('/api/v1/cases')).json(), before)
  const metrics = await (await get('/api/v1/metrics')).json()
  assert.equal(metrics.cases, 13)
  assert.equal(Object.values(metrics.proposals).reduce((sum, count) => sum + count), 13)
  assert.equal(metrics.refundsIssuedCents, 0)
})

test('bounded CLI rejects host/token/file overrides and never widens its listener', async () => {
  assert.deepEqual(parseInspectorDemoArgs([]), { port: 5293 })
  assert.deepEqual(parseInspectorDemoArgs(['--port', '0']), { port: 0 })
  for (const args of [['--host', '0.0.0.0'], ['--token', 'real'], ['--file', '.env'], ['--port', '80'], ['--port', '65536'], ['--port', '05293'], ['--port', '5293', '--host', 'localhost']]) assert.throws(() => parseInspectorDemoArgs(args))
  await assert.rejects(startInspectorDemo({ port: 80 }))
  await assert.rejects(createInspectorDemoServer({ now: NaN }))
})

test('actual ephemeral CLI ignores hostile ambient production targets and shuts down only its owned child', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../inspector-demo.mjs', import.meta.url)), '--port', '0'], {
    env: { ...process.env, HOST: '0.0.0.0', PORT: '80', API_PORT: '80', OPERATOR_TOKEN: 'not-demo', DATABASE_URL: 'postgres://must-not-connect.invalid/demo', API_PROXY_TARGET: 'https://must-not-connect.invalid', PUBLIC_UMAMI_SCRIPT_URL: 'https://must-not-connect.invalid/script.js' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit') } })
  let output = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Demo child did not become ready')), 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', bytes => { output += bytes; const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[0]) } })
    child.stderr.on('data', bytes => { output += bytes })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Demo child exited before ready (${code})`)) })
  })
  const base = await ready
  assert.equal((await fetch(base + '/api/v1/operator/session', { headers: auth })).status, 200)
  assert.equal((await fetch(base + '/api/v1/operator/session', { headers: { Authorization: 'Bearer not-demo' } })).status, 401)
  assert.doesNotMatch(output, /not-demo|DATABASE|must-not-connect|0\.0\.0\.0/)
})
