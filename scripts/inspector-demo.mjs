// Presentation-only synthetic API. No application bootstrap, env loader, store or upstream client.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const inspectorTemplateIds = Object.freeze(['payments', 'delivery', 'orders', 'returns', 'booking', 'appointments', 'subscription', 'account', 'access', 'incident', 'warranty', 'escalation'])
export const inspectorDemoHost = '127.0.0.1'
export const inspectorDemoToken = '1111' // Public synthetic-only credential; never used by the production API.
const fixtureUrl = new URL('../examples/inspector/scenarios.v1.json', import.meta.url)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const statuses = ['pending', 'approved', 'executing', 'executed', 'rejected', 'failed', 'denied', 'unknown', 'expired', 'invalidated']
const caseStatuses = ['open', 'awaiting_approval', 'escalated', 'resolved']
const intents = ['duplicate_charge', 'refund_request', 'billing_question', 'cancel_subscription', 'complaint', 'other']
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b)).map(key => [key, canonical(value[key])])) : value
export const fixtureArgsHash = (caseId, tool, args) => createHash('sha256').update(JSON.stringify([caseId, tool, canonical(args)])).digest('hex')
const fail = () => { throw new Error('Invalid inspector fixture') }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

export async function loadInspectorFixtures() {
  const bytes = await readFile(fixtureUrl)
  if (bytes.length > 1_000_000) fail()
  const fixture = JSON.parse(bytes.toString('utf8'))
  if (fixture.fixtureFormat !== 1 || fixture.kind !== 'inspector-presentation' || !Number.isFinite(Date.parse(fixture.clock)) || fixture.scenarios?.length !== 13) fail()
  const ids = new Set()
  for (const scenario of fixture.scenarios) {
    const { detail, business } = scenario
    if (!detail || !business || ids.has(scenario.id)) fail()
    ids.add(scenario.id)
    const supportCase = detail.case
    if (![business.id, supportCase.id, supportCase.customerId, detail.customer.id].every(id => uuid.test(id)) || supportCase.businessId !== business.id || detail.customer.businessId !== business.id || supportCase.customerId !== detail.customer.id || !caseStatuses.includes(supportCase.status)) fail()
    if (!intents.includes(supportCase.intent) || supportCase.analysis?.intent !== supportCase.intent || !['low', 'medium', 'high'].includes(supportCase.analysis?.sentiment?.urgency) || typeof supportCase.analysis.sentiment.abusive !== 'boolean') fail()
    if (detail.payments.some(payment => payment.customerId !== detail.customer.id) || detail.audit.some(event => event.caseId !== supportCase.id)) fail()
    if (scenario.id !== 'payments' && (detail.payments.length || detail.refunds.length)) fail()
    if (!detail.customer.email.endsWith('@example.invalid') || detail.runs.length) fail()
    for (const message of detail.messages) if (message.caseId !== supportCase.id || !uuid.test(message.id)) fail()
    for (const proposal of detail.proposals) {
      const args = proposal.args
      if (!uuid.test(proposal.id) || proposal.caseId !== supportCase.id || proposal.tool !== 'external_action' || !statuses.includes(proposal.status) || fixtureArgsHash(proposal.caseId, proposal.tool, args) !== proposal.argsHash) fail()
      if (args.businessId !== business.id || args.caseId !== supportCase.id || args.customerId !== detail.customer.id || args.ownershipVersion !== supportCase.ownershipVersion || args.effect !== 'write' || !args.input || Array.isArray(args.input)) fail()
      if (proposal.status !== 'executed' && proposal.result?.data !== undefined) fail()
      if (proposal.status === 'executed' && (!proposal.result?.data || Array.isArray(proposal.result.data))) fail()
      if (scenario.id !== 'generic' && (args.tags.length !== 1 || args.tags[0] !== `eldhall.ui.${scenario.id}`)) fail()
    }
  }
  if (![...inspectorTemplateIds, 'generic'].every(id => ids.has(id))) fail()
  return freeze(fixture)
}

function materialize(fixture, now) {
  const delta = now - Date.parse(fixture.clock)
  const shift = value => value === null ? null : new Date(Date.parse(value) + delta).toISOString()
  const copy = structuredClone(fixture)
  for (const { detail } of copy.scenarios) {
    detail.case.createdAt = shift(detail.case.createdAt)
    detail.case.updatedAt = shift(detail.case.updatedAt)
    for (const entry of [...detail.messages, ...detail.audit, ...detail.runs]) entry.createdAt = shift(entry.createdAt)
    for (const proposal of detail.proposals) {
      proposal.createdAt = shift(proposal.createdAt)
      proposal.decidedAt = shift(proposal.decidedAt)
      proposal.args.expiresAt = shift(proposal.args.expiresAt)
      proposal.argsHash = fixtureArgsHash(proposal.caseId, proposal.tool, proposal.args)
    }
  }
  return freeze(copy)
}
function metrics(scenarios) {
  const byStatus = Object.fromEntries(caseStatuses.map(status => [status, 0]))
  const proposals = Object.fromEntries(statuses.map(status => [status, 0]))
  const byPriority = {}
  for (const { detail } of scenarios) {
    byStatus[detail.case.status]++
    byPriority[detail.case.priority] = (byPriority[detail.case.priority] ?? 0) + 1
    for (const proposal of detail.proposals) proposals[proposal.status]++
  }
  return { cases: scenarios.length, byStatus, byPriority, proposals, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null }
}

/** Importing this module never starts a listener; callers own server.close(). */
export async function createInspectorDemoServer({ now = Date.now() } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid demo clock')
  const fixture = materialize(await loadInspectorFixtures(), now)
  return createServer((request, response) => {
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
      response.end(JSON.stringify(value))
    }
    // No mutation route exists, including approve/execute/reconcile/message/ownership/reset.
    if (request.method !== 'GET') { request.resume(); return send(405, { detail: 'Inspector demo is read-only; no operation was performed.' }, { Allow: 'GET' }) }
    let url
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { return send(400, { detail: 'Invalid request' }) }
    if (url.pathname === '/health/ready') return send(200, { status: 'ok', mode: 'inspector-demo', persistence: 'none', readOnly: true })
    if (request.headers.authorization !== `Bearer ${inspectorDemoToken}`) return send(401, { detail: 'Invalid operator token' }, { 'WWW-Authenticate': 'Bearer' })
    if (url.pathname === '/api/v1/operator/session') return send(200, { authenticated: true })
    // Explicit identity for this synthetic read-only template gallery, never a runtime tenant selector.
    if (url.pathname === '/api/v1/workspace') return send(200, { business: { id: fixture.scenarios[0].business.id, name: 'Inspector templates', slug: 'inspector-gallery', currency: fixture.scenarios[0].business.currency } })
    if (url.pathname === '/api/v1/guards') return send(200, { version: 1, revision: 0, rules: [], definitions: ['deny_action', 'amount_limit', 'require_approval'].map(kind => ({ kind, definitionVersion: 1, title: kind, description: 'Presentation metadata only; this fixture has no executable actions.', targetTools: kind === 'amount_limit' ? ['refund_payment'] : ['refund_payment', 'external_action'] })) })
    if (url.pathname === '/api/v1/businesses') return send(200, { businesses: fixture.scenarios.map(scenario => scenario.business) })
    const business = url.searchParams.get('businessId')
    if (url.searchParams.getAll('businessId').length > 1) return send(422, { detail: 'One businessId is required' })
    const scenarios = business ? fixture.scenarios.filter(scenario => scenario.business.id === business) : fixture.scenarios
    if (business && !scenarios.length) return send(404, { detail: 'Demo business not found' })
    if (url.pathname === '/api/v1/cases') return send(200, scenarios.map(scenario => scenario.detail.case))
    if (url.pathname === '/api/v1/metrics') return send(200, metrics(scenarios))
    if (url.pathname.startsWith('/api/v1/cases/')) {
      const scenario = scenarios.find(item => url.pathname === `/api/v1/cases/${item.detail.case.id}`)
      return scenario ? send(200, scenario.detail) : send(404, { detail: 'Demo case not found' })
    }
    if (url.pathname === '/api/v1/capabilities') return send(200, { runtime: 'inspector-demo', provider: 'none', model: 'none', persistence: 'none', paymentProvider: 'not-connected', knowledgeSearch: 'none', credentialsConfigured: false, maxToolCalls: 0 })
    if (url.pathname === '/api/v1/knowledge') return send(200, { sources: [], capabilities: { create: false, update: false, publish: false } })
    if (url.pathname === '/api/v1/team') return send(200, { members: [], capabilities: { invite: false, updateRole: false } })
    if (url.pathname === '/api/v1/integrations') return send(200, { integrations: [] })
    if (url.pathname === '/api/v1/skills') return send(200, { preset: 'presentation-only', skills: [] })
    if (url.pathname === '/api/v1/settings') return send(200, { businessId: scenarios[0].business.id, language: 'uk', tone: 'empathetic', version: 1, requireApproval: true, refundLimitCents: 0, duplicateWindowMinutes: 0, enabledTools: [], classification: null })
    return send(404, { detail: 'Route is not part of the inspector presentation demo' })
  })
}
export async function startInspectorDemo({ port = 5293, now } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('Port must be 0 or 1024–65535')
  const server = await createInspectorDemoServer({ now })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, inspectorDemoHost, () => { server.removeListener('error', reject); resolve() }) })
  return server
}
export function parseInspectorDemoArgs(args) {
  if (!args.length) return { port: 5293 }
  if (args.length !== 2 || args[0] !== '--port' || !/^(?:0|[1-9]\d{3,4})$/.test(args[1])) throw new Error('Usage: node scripts/inspector-demo.mjs [--port 0|1024..65535]')
  const port = Number(args[1])
  if (port !== 0 && (port < 1024 || port > 65535)) throw new Error('Invalid demo port')
  return { port }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startInspectorDemo(parseInspectorDemoArgs(process.argv.slice(2)))
    console.log(`Inspector presentation API: http://${inspectorDemoHost}:${server.address().port} (synthetic, read-only)`)
    const stop = () => { server.close(); server.closeAllConnections() }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  } catch { console.error('Inspector demo could not start; check the fixed fixture and allowed --port argument.'); process.exitCode = 1 }
}
