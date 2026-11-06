import { render, screen, within } from '../test/render'
import { beforeEach, expect, it, vi } from 'vitest'
import App from '../App'
import { request } from '../lib/api'
import type { CaseDetail, TicketClassification } from '../lib/api'

const timestamp = '2026-10-31T10:00:00.000Z'
const classified: TicketClassification = { classId: '1', label: 'Оплата за послуги', confidence: 0.92, reason: 'Клієнт запитує про рахунок.', revision: 3, needsReview: false, source: 'llm', reasonCode: 'classified', provider: 'openrouter', model: 'openai/gpt-6-luna-decisions' }
function detail(classification: TicketClassification | null): CaseDetail {
  return {
    case: { id: 'classified-case', businessId: 'business-1', customerId: 'customer-1', customerName: 'Synthetic Test Customer', status: 'open', priority: 'P3', intent: 'billing_question', analysis: { intent: 'billing_question', summary: 'Питання про рахунок', reasoning: 'Потрібне пояснення рахунка.', priority: 'P3', tone: 'neutral', source: 'llm', model: 'test-model', sentiment: { label: 'calm', frustration: 0, escalationRisk: 0, urgency: 'low', signals: [] }, classification }, ownership: 'bot', ownershipVersion: 0, createdAt: timestamp, updatedAt: timestamp },
    customer: { id: 'customer-1', businessId: 'business-1', name: 'Synthetic Test Customer', email: 'synthetic@example.test', plan: 'Test' },
    messages: [], proposals: [], payments: [], refunds: [], audit: [], runs: [],
  }
}
function mockWorkspace(classification: TicketClassification | null) {
  const current = detail(classification)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw new Error('Classification display must not mutate support state')
    const path = String(input)
    if (path === '/api/v1/workspace') return new Response(JSON.stringify({ business: { id: 'business-1', name: 'Fixture Bank', slug: 'fixture-bank', currency: 'UAH' } }), { headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/v1/operator/session') return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Content-Type': 'application/json' } })
    const payload = path === '/api/v1/cases' ? [current.case] : path === '/api/v1/cases/classified-case' ? current : { cases: 1, byStatus: { open: 1, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: { P1: 0, P2: 0, P3: 1 }, proposals: {}, refundsIssuedCents: 0, agentRuns: 1, fallbackRuns: 0, avgAgentLatencyMs: 100 }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('support.operator', 'test-operator-token')
  window.history.replaceState({}, '', '/operator')
})

it('shows the persisted business class snapshot and identifies confidence as a model estimate', async () => {
  const fetch = mockWorkspace(classified)
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  const classification = await screen.findByRole('region', { name: 'Класифікація тікета' })
  expect(within(classification).getByText('Оплата за послуги')).toBeInTheDocument()
  expect(within(classification).getByText('ID 1 · версія 3')).toBeInTheDocument()
  expect(within(classification).getByText(/Оцінка впевненості моделі: 92/)).toBeInTheDocument()
  expect(within(classification).getByText(/не виміряна точність/)).toBeInTheDocument()
  expect(within(classification).getByText('Класифікатор: openrouter · openai/gpt-6-luna-decisions')).toBeInTheDocument()
  expect(within(classification).queryByText('Потребує перевірки оператором')).not.toBeInTheDocument()
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
})

it('shows fallback classes as requiring human review without claiming model confidence', async () => {
  mockWorkspace({ ...classified, classId: 'other', label: 'Інше', confidence: 0, source: 'fallback', reasonCode: 'model_fallback', needsReview: true })
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  const classification = await screen.findByRole('region', { name: 'Класифікація тікета' })
  expect(within(classification).getByText('Інше')).toBeInTheDocument()
  expect(within(classification).getByText('Потребує перевірки оператором')).toBeInTheDocument()
  expect(within(classification).getByText(/Резервна класифікація/)).toBeInTheDocument()
  expect(within(classification).queryByText(/Оцінка впевненості моделі:/)).not.toBeInTheDocument()
})

it('keeps cases without configured classification usable', async () => {
  mockWorkspace(null)
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  expect(await screen.findByText('Потрібне пояснення рахунка.')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Класифікація тікета' })).not.toBeInTheDocument()
})

it('distinguishes a low-score proposed candidate from the final review class', async () => {
  mockWorkspace({ ...classified, classId: 'other', label: 'Інше', confidence: 0.4, needsReview: true, reasonCode: 'low_confidence', proposedClassId: '1', proposedLabel: 'Оплата за послуги', scoreKind: 'selected_probability' })
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  const classification = await screen.findByRole('region', { name: 'Класифікація тікета' })
  expect(within(classification).getByText('Інше')).toBeInTheDocument()
  expect(within(classification).getByText(/Запропонований кандидат:/)).toHaveTextContent('Оплата за послуги')
  expect(within(classification).getByText(/Імовірність вибору для кандидата: 40/)).toBeInTheDocument()
  expect(within(classification).getByText('Потребує перевірки оператором')).toBeInTheDocument()
})

it('rejects malformed classification metadata rather than rendering unchecked model scores', async () => {
  const current = detail(classified)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ ...current.case, analysis: { ...current.case.analysis, classification: { ...classified, confidence: 4 } } }]), { headers: { 'Content-Type': 'application/json' } })))
  await expect(request('/cases', 'test-operator-token')).rejects.toMatchObject({ name: 'ApiError', status: 200, uiMessage: { key: 'core.error.invalidResponse' } })
})

it('does not present the normalized zero of an invalid model class as a measured probability', async () => {
  mockWorkspace({ ...classified, classId: 'other', label: 'Інше', confidence: 0, needsReview: true, reasonCode: 'unknown_class', scoreKind: 'selected_probability' })
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  const classification = await screen.findByRole('region', { name: 'Класифікація тікета' })
  expect(within(classification).getByText('Резервна класифікація: модель не визначила допустимий клас.')).toBeInTheDocument()
  expect(within(classification).queryByText(/Імовірність вибору:/)).not.toBeInTheDocument()
})
