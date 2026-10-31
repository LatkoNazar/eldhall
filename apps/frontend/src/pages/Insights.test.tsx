import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from '../App'
import { Insights } from './Insights'
import type { InsightRun } from '../lib/insights-api'

const businessId = '30000000-0000-4000-8000-000000000001'
const foreignId = '30000000-0000-4000-8000-000000000002'
const runId = '30000000-0000-4000-8000-000000000010'
const findingId = '30000000-0000-4000-8000-000000000020'
const caseId = '30000000-0000-4000-8000-000000000030'
const messageId = '30000000-0000-4000-8000-000000000040'
const draftId = '30000000-0000-4000-8000-000000000050'
const timestamp = '2026-10-31T11:00:00.000Z'
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function completed(): InsightRun {
  return { id: runId, businessId, status: 'completed', createdAt: timestamp, completedAt: timestamp, provider: 'dsh:google', model: 'gemini-3.5-flash-lite', sample: { caseCount: 2, messageCount: 3, knowledgeCount: 1, totalCases: 5, totalPublishedKnowledge: 2, truncated: true, from: timestamp, to: timestamp }, findings: [{ id: findingId, kind: 'knowledge_gap', title: 'Пояснити відновлення доступу', summary: 'У вибірці є запит про відновлення, а покрокової інструкції не знайдено.', recommendation: 'Перевірте чинний процес та додайте перевірену інструкцію.', caseCount: 1, evidence: [{ caseId, messageIds: [messageId] }], knowledgeRefs: [], proposedArticle: { title: 'Відновлення доступу', content: 'Потребує перевірки бізнесом: уточніть дозволений процес відновлення.' }, draftId: null }], error: null, stale: false }
}
function serve(handler: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const value = handler(path, init)
    if (value) return value
    if (path === '/api/v1/businesses') return response({ businesses: [{ id: businessId, name: 'Synthetic Store', currency: 'UAH' }, { id: foreignId, name: 'Other Store', currency: 'UAH' }] })
    if (path === '/api/v1/cases') return response([])
    if (path === '/api/v1/metrics') return response({ cases: 0, byStatus: { open: 0, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: { P1: 0, P2: 0, P3: 0 }, proposals: {}, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null })
    return response({ detail: `Unexpected test route ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, '', '/operator/analytics?view=insights') })

it('admits analysis only on request, displays queued progress and renders actual partial-sample evidence', async () => {
  let submitted = false
  let finish!: () => void
  const finished = new Promise<Response>(resolve => { finish = () => resolve(response({ runs: [completed()] })) })
  const fetch = serve((path, init) => {
    if (path === '/api/v1/insights/runs' && init?.method === 'POST') { submitted = true; return response({ ...completed(), status: 'queued', findings: [], completedAt: null, sample: { caseCount: 0, messageCount: 0, knowledgeCount: 0, totalCases: 0, totalPublishedKnowledge: 0, truncated: false, from: null, to: null } }, 202) }
    if (path === `/api/v1/insights/runs?businessId=${businessId}`) return submitted ? finished : response({ runs: [] })
  })
  const user = userEvent.setup()
  render(<Insights token="test-operator" />)
  const start = await screen.findByRole('button', { name: 'Аналізувати тікети' })
  await waitFor(() => expect(start).toBeEnabled())
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  await user.click(start)
  expect(await screen.findByRole('heading', { name: 'У черзі' })).toBeInTheDocument()
  expect(screen.getAllByText('Ще формується')).toHaveLength(3)
  expect(start).toBeDisabled()
  const post = fetch.mock.calls.find(([path, init]) => String(path) === '/api/v1/insights/runs' && init?.method === 'POST')
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ businessId, limit: 25, clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  finish()
  const finding = await screen.findByRole('article', { name: 'Пояснити відновлення доступу' })
  expect(screen.getByText('2 з 5')).toBeInTheDocument()
  expect(screen.getByText(/Проаналізовано обмежену вибірку/)).toBeInTheDocument()
  expect(screen.getByText(/Гіпотези AI/)).toBeInTheDocument()
  await user.click(within(finding).getByText('Звернення та повідомлення-джерела (1)'))
  expect(within(finding).getByRole('link', { name: /Відкрити звернення/ })).toHaveAttribute('href', `/operator?caseId=${caseId}`)
  expect(within(finding).getByText(new RegExp(messageId))).toBeInTheDocument()
})

it('creates an ordinary draft only after a fresh result read and never publishes it', async () => {
  let drafted = false
  const fetch = serve((path, init) => {
    if (path === `/api/v1/insights/runs?businessId=${businessId}`) return response({ runs: [{ ...completed(), findings: completed().findings.map(item => ({ ...item, draftId: drafted ? draftId : null })) }] })
    if (path === `/api/v1/insights/runs/${runId}?businessId=${businessId}`) return response(completed())
    if (path.endsWith(`/findings/${findingId}/draft?businessId=${businessId}`) && init?.method === 'POST') { drafted = true; return response({ draft: { id: draftId, businessId, title: 'Відновлення доступу', content: 'Перевірити процес бізнесу.', status: 'draft', version: 1 } }) }
  })
  const user = userEvent.setup()
  render(<Insights token="test-operator" />)
  await user.click(await screen.findByRole('button', { name: 'Створити чернетку KB' }))
  const link = await screen.findByRole('link', { name: 'Відкрити документ KB' })
  expect(link).toHaveAttribute('href', `/operator/knowledge?businessId=${businessId}&documentId=${draftId}`)
  expect(link).toHaveFocus()
  const detailIndex = fetch.mock.calls.findIndex(([path]) => String(path) === `/api/v1/insights/runs/${runId}?businessId=${businessId}`)
  const draftIndex = fetch.mock.calls.findIndex(([path]) => String(path).includes('/findings/'))
  expect(detailIndex).toBeGreaterThan(-1)
  expect(draftIndex).toBeGreaterThan(detailIndex)
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/publish'))).toBe(false)
  expect(screen.queryByRole('button', { name: 'Створити чернетку KB' })).not.toBeInTheDocument()
})

it('hides revoked-source findings after preflight and dispatches no draft request', async () => {
  let stale = false
  const staleRun = { ...completed(), stale: true, findings: [], error: 'Джерело відкликано.' }
  const fetch = serve(path => {
    if (path === `/api/v1/insights/runs?businessId=${businessId}`) return response({ runs: [stale ? staleRun : completed()] })
    if (path === `/api/v1/insights/runs/${runId}?businessId=${businessId}`) { stale = true; return response(staleRun) }
  })
  const user = userEvent.setup()
  render(<Insights token="test-operator" />)
  await user.click(await screen.findByRole('button', { name: 'Створити чернетку KB' }))
  expect(await screen.findByText(/Попередні пропозиції приховано/)).toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'Пояснити відновлення доступу' })).not.toBeInTheDocument()
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

it('clears the previous business and ignores its delayed read after switching scope', async () => {
  let delayed = false
  let release!: () => void
  const oldRead = new Promise<Response>(resolve => { release = () => resolve(response({ runs: [completed()] })) })
  serve(path => {
    if (path === `/api/v1/insights/runs?businessId=${businessId}`) return delayed ? oldRead : response({ runs: [completed()] })
    if (path === `/api/v1/insights/runs?businessId=${foreignId}`) return response({ runs: [{ ...completed(), businessId: foreignId, findings: [] }] })
  })
  const user = userEvent.setup()
  render(<Insights token="test-operator" />)
  expect(await screen.findByRole('article', { name: 'Пояснити відновлення доступу' })).toBeInTheDocument()
  delayed = true
  await user.click(screen.getByRole('button', { name: 'Оновити' }))
  await user.selectOptions(screen.getByRole('combobox', { name: 'Бізнес для аналізу' }), foreignId)
  expect(screen.queryByRole('article', { name: 'Пояснити відновлення доступу' })).not.toBeInTheDocument()
  release()
  expect(await screen.findByRole('heading', { name: 'У цій вибірці немає пропозицій' })).toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'Пояснити відновлення доступу' })).not.toBeInTheDocument()
})

it('renders failed analysis honestly without fabricated findings', async () => {
  serve(path => path.startsWith('/api/v1/insights/runs?') ? response({ runs: [{ ...completed(), status: 'failed', findings: [], error: 'Модель не завершила аналіз.' }] }) : undefined)
  render(<Insights token="test-operator" />)
  expect(await screen.findByRole('heading', { name: 'Не вдалося завершити' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Модель не завершила аналіз.')
  expect(screen.queryByRole('button', { name: 'Створити чернетку KB' })).not.toBeInTheDocument()
})

it('identifies an empty completed sample without claiming a model invocation', async () => {
  serve(path => path.startsWith('/api/v1/insights/runs?') ? response({ runs: [{ ...completed(), findings: [], sample: { caseCount: 0, messageCount: 0, knowledgeCount: 0, totalCases: 0, totalPublishedKnowledge: 0, truncated: false, from: null, to: null } }] }) : undefined)
  render(<Insights token="test-operator" />)
  expect(await screen.findByRole('heading', { name: 'Немає повідомлень для аналізу' })).toBeInTheDocument()
  expect(screen.getByText('Не викликалася: порожня вибірка')).toBeInTheDocument()
  expect(screen.queryByText(/Гіпотези AI/)).not.toBeInTheDocument()
})

it('rejects cross-business run data and blocks writes until valid data is read', async () => {
  serve(path => path.startsWith('/api/v1/insights/runs?') ? response({ runs: [{ ...completed(), businessId: foreignId }] }) : undefined)
  render(<Insights token="test-operator" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Некоректна структура результату аналізу')
  expect(screen.getByRole('button', { name: 'Аналізувати тікети' })).toBeDisabled()
  expect(screen.queryByRole('article')).not.toBeInTheDocument()
})

it('reuses the admission request identity after an ambiguous response', async () => {
  let posts = 0
  const fetch = serve((path, init) => {
    if (path === '/api/v1/insights/runs' && init?.method === 'POST') {
      posts++
      if (posts === 1) throw new TypeError('Synthetic lost response')
      return response({ ...completed(), findings: [] }, 202)
    }
    if (path.startsWith('/api/v1/insights/runs?')) return response({ runs: [] })
  })
  const user = userEvent.setup()
  render(<Insights token="test-operator" />)
  const start = await screen.findByRole('button', { name: 'Аналізувати тікети' })
  await waitFor(() => expect(start).toBeEnabled())
  await user.click(start)
  await user.click(await screen.findByRole('button', { name: 'Перевірити прийнятий запуск' }))
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2))
  const payloads = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)) as unknown)
  expect(payloads[0]).toEqual(payloads[1])
})

it('exposes the insights view through keyboard-accessible Analytics tabs', async () => {
  window.history.replaceState({}, '', '/operator/analytics')
  sessionStorage.setItem('support.operator', 'test-operator')
  serve(path => path.startsWith('/api/v1/insights/runs?') ? response({ runs: [] }) : undefined)
  const user = userEvent.setup()
  render(<App />)
  const metrics = screen.getByRole('tab', { name: 'Показники' })
  metrics.focus()
  await user.keyboard('{ArrowRight}')
  const insights = screen.getByRole('tab', { name: 'Проблеми та KB' })
  expect(insights).toHaveFocus()
  expect(insights).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByRole('heading', { name: 'Проблеми тікетів і KB' })).toBeInTheDocument()
  expect(within(screen.getByRole('navigation', { name: 'Головна навігація' })).getAllByRole('link')).toHaveLength(6)
})

it('opens the cited case even when it is outside the current queue page', async () => {
  window.history.replaceState({}, '', `/operator?caseId=${caseId}`)
  sessionStorage.setItem('support.operator', 'test-operator')
  const linked = { id: caseId, businessId, customerId: 'customer-linked', customerName: 'Linked Synthetic Customer', status: 'open', priority: 'P3', intent: null, analysis: null, ownership: 'bot', ownershipVersion: 0, createdAt: timestamp, updatedAt: timestamp }
  const fetch = serve(path => {
    if (path === '/api/v1/cases') return response([{ ...linked, id: 'queue-first', customerName: 'Queue Synthetic Customer' }])
    if (path === `/api/v1/cases/${caseId}`) return response({ case: linked, customer: { id: 'customer-linked', businessId, name: linked.customerName, email: 'linked@example.test', plan: 'Test' }, messages: [], proposals: [], payments: [], refunds: [], audit: [], runs: [] })
  })
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Linked Synthetic Customer' })).toBeInTheDocument()
  expect(fetch.mock.calls.some(([path]) => String(path) === '/api/v1/cases/queue-first')).toBe(false)
})
