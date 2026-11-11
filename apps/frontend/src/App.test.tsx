import { render, screen, waitFor } from './test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { CaseDetail, CustomerCase, Metrics, ProposalStatus } from './lib/api'

const timestamp = '2026-10-31T10:00:00.000Z'
const argsHash = 'b'.repeat(64)
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function detail(status: ProposalStatus = 'pending'): CaseDetail {
  return {
    case: { id: 'case-1', businessId: 'business-1', customerId: 'customer-1', customerName: 'Олена', status: 'awaiting_approval', priority: 'P1', intent: 'duplicate_charge', analysis: null, ownership: 'bot', ownershipVersion: 0, assignedTo: null, createdAt: timestamp, updatedAt: timestamp },
    customer: { id: 'customer-1', businessId: 'business-1', name: 'Олена', email: 'synthetic@example.test', plan: 'Monthly' },
    messages: [{ id: 'message-1', caseId: 'case-1', role: 'customer', body: 'З мене списали двічі', createdAt: timestamp }],
    payments: [{ id: 'payment-1', amountCents: 49900, currency: 'UAH', description: 'Підписка', merchantRef: 'SIM-1', status: 'captured', createdAt: timestamp }],
    proposals: [{ id: 'proposal-1', caseId: 'case-1', tool: 'refund_payment', args: { payment_id: 'payment-1', amount_cents: 49900 }, argsHash, risk: 'high', status, policy: { allowed: true, requiresApproval: true, checks: [{ name: 'Власник платежу', passed: true, detail: 'Платіж належить клієнту' }] }, decidedBy: null, decidedAt: null, result: null, error: null, createdAt: timestamp }],
    audit: [], runs: [], refunds: [],
  }
}
const metrics: Metrics = { cases: 1, byStatus: { open: 0, awaiting_approval: 1, escalated: 0, resolved: 0 }, byPriority: { P1: 1, P2: 0, P3: 0 }, proposals: { pending: 1, approved: 0, executing: 0, executed: 0, rejected: 0, denied: 0, failed: 0, unknown: 0, expired: 0, invalidated: 0 }, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null }

beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, '', '/operator') })
function operatorSession() { sessionStorage.setItem('support.operator', 'test-operator-token') }
function mockOperator(extra?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  let current = detail()
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/workspace') return response({ business: { id: 'business-1', name: 'Бізнес А', slug: 'a', currency: 'UAH' } })
    const override = extra?.(path, init)
    if (override) return override
    if (path === '/api/v1/operator/session') return response({ authenticated: true })
    if (path === '/api/v1/cases') return response([current.case])
    if (path === '/api/v1/metrics') return response(metrics)
    if (path === '/api/v1/cases/case-1') return response(current)
    if (path.endsWith('/approve')) { current = detail('approved'); return response({ case: current.case, proposal: current.proposals[0] }) }
    if (path.endsWith('/execute')) { current = detail('executed'); return response({ case: current.case, proposal: current.proposals[0] }) }
    return response({ detail: 'Unexpected endpoint' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('operator workspace', () => {
  it('keeps the dashboard behind an explicit operator token', async () => {
    const fetch = mockOperator()
    render(<App />)
    expect(fetch).not.toHaveBeenCalled()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Ключ доступу оператора'), 'test-operator-token')
    await user.click(screen.getByRole('button', { name: /Увійти/ }))
    expect(await screen.findByText('З мене списали двічі')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/v1/cases', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-operator-token' }), signal: expect.any(AbortSignal), cache: 'no-store' }))
  })

  it('binds approval to exact arguments and executes only on a separate explicit action', async () => {
    operatorSession()
    const fetch = mockOperator()
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByText('Платіж належить клієнту')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Погодити повернення' }))
    expect(await screen.findByRole('button', { name: 'Виконати погоджену дію' })).toBeInTheDocument()
    const approval = fetch.mock.calls.find(([url]) => String(url).endsWith('/approve'))
    expect(JSON.parse(String(approval?.[1]?.body))).toEqual({ argsHash })
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
    expect(await screen.findByText('Повернення виконано симульованим провайдером.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Погодити повернення' })).not.toBeInTheDocument()
    const execution = fetch.mock.calls.find(([url]) => String(url).endsWith('/execute'))
    expect(JSON.parse(String(execution?.[1]?.body))).toEqual({ argsHash })
  })

  it('shows approval conflicts without claiming a completed action', async () => {
    operatorSession()
    mockOperator(path => path.endsWith('/approve') ? response({ detail: 'Аргументи змінилися. Потрібна нова перевірка.' }, 409) : undefined)
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Погодити повернення' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Аргументи змінилися')
    expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
    expect(screen.queryByText('Повернення виконано симульованим провайдером.')).not.toBeInTheDocument()
  })

  it('retains a failed provider result rather than showing success', async () => {
    operatorSession()
    mockOperator(path => path === '/api/v1/cases/case-1' ? response(detail('approved')) : path.endsWith('/execute') ? response({ proposal: { ...detail('failed').proposals[0], error: 'Провайдер не підтвердив повернення' }, case: detail().case }, 502) : undefined)
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Виконати погоджену дію' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Провайдер не підтвердив повернення')
    expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
    expect(screen.getByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  })

  it('rejects malformed API payloads instead of crashing or fabricating records', async () => {
    operatorSession()
    mockOperator(path => path === '/api/v1/cases' ? response({ status: 'ok' }) : undefined)
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Некоректна структура відповіді сервера')
    expect(screen.queryByText('З мене списали двічі')).not.toBeInTheDocument()
  })
})

describe('customer channel', () => {
  it('opens the composer directly and sends the first message using the default demo session', async () => {
    window.history.replaceState({}, '', '/chat')
    let conversation: CustomerCase = { id: 'case-1', businessName: 'Демо-сервіс', status: 'open', messages: [] }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/personas')) return response([{ name: 'Олена', plan: 'Monthly', sessionToken: 'demo-olena', businessName: 'Демо-сервіс' }])
      if (path.endsWith('/chat/test-cases')) return response({ id: 'case-1', status: 'open', isTest: true }, 201)
      if (path.endsWith('/messages') && init?.method === 'POST') { conversation = { ...conversation, messages: [{ id: 'reply-1', caseId: 'case-1', role: 'assistant', body: 'Підготували дію для погодження оператором.', createdAt: timestamp }] }; return response({ caseId: 'case-1', status: 'awaiting_approval', reply: conversation.messages[0] }) }
      return response(conversation)
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByRole('textbox', { name: 'Ваше повідомлення' }), 'З мене списали двічі')
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(screen.queryByRole('button', { name: /Олена/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Надіслати' }))
    expect(await screen.findByText('Підготували дію для погодження оператором.')).toBeInTheDocument()
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([path]) => path)).toEqual(['/api/v1/chat/test-cases', '/api/v1/chat/cases/case-1/messages'])
    for (const [, init] of writes) {
      expect(init?.headers).toEqual(expect.objectContaining({ 'X-Customer-Session': 'demo-olena' }))
      expect(init?.headers).not.toHaveProperty('Authorization')
    }
    expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual({ body: 'З мене списали двічі' })
    await user.click(screen.getByRole('button', { name: 'Новий діалог' }))
    expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toHaveValue('')
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
  })

  it('retains the first draft and reuses the case on retry when the demo session is unavailable', async () => {
    window.history.replaceState({}, '', '/chat')
    let attempts = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/personas')) return response({ detail: 'Not found' }, 404)
      if (path.endsWith('/chat/cases')) return response({ id: 'case-1' }, 201)
      if (path.endsWith('/messages') && init?.method === 'POST') {
        attempts += 1
        if (attempts === 1) return response({ detail: 'Temporarily unavailable' }, 503)
        return response({ caseId: 'case-1', status: 'open', ownership: 'staff', reply: null }, 202)
      }
      return response({ id: 'case-1', status: 'open', businessName: 'Сервіс', messages: [] })
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<App />)
    const draft = screen.getByRole('textbox', { name: 'Ваше повідомлення' })
    await user.type(draft, 'Питання про оплату')
    await user.type(await screen.findByLabelText('Ключ клієнтської сесії'), 'customer-session')
    const send = screen.getByRole('button', { name: 'Надіслати' })
    await user.click(send)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(draft).toHaveValue('Питання про оплату')
    await waitFor(() => expect(send).toBeEnabled())
    await user.click(send)
    await waitFor(() => expect(draft).toHaveValue(''))
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([path]) => path)).toEqual([
      '/api/v1/chat/cases', '/api/v1/chat/cases/case-1/messages', '/api/v1/chat/cases/case-1/messages',
    ])
    expect(writes.every(([, init]) => new Headers(init?.headers).get('X-Customer-Session') === 'customer-session')).toBe(true)
  })

  it('keeps an accepted worker turn pending until polling confirms the assistant reply, preserving later drafts', async () => {
    const browserTimers: Pick<Window, 'setTimeout'> = window
    const originalTimeout = browserTimers.setTimeout.bind(browserTimers)
    const polling = vi.spyOn(browserTimers, 'setTimeout').mockImplementation((handler, delay, ...args) => originalTimeout(handler, delay === 2500 ? 20 : delay, ...args))
    try {
      window.history.replaceState({}, '', '/chat')
      let conversation: CustomerCase = { id: 'case-1', businessName: 'Демо-сервіс', status: 'open', ownership: 'bot', activeRun: null, messages: [] }
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.endsWith('/personas')) return response([{ name: 'Олена', plan: 'Monthly', sessionToken: 'demo-olena', businessName: 'Демо-сервіс' }])
        if (path.endsWith('/chat/test-cases')) return response({ id: 'case-1', status: 'open', isTest: true }, 201)
        if (path.endsWith('/messages') && init?.method === 'POST') {
          conversation = { ...conversation, activeRun: { id: 'run-1', status: 'queued' }, messages: [{ id: 'customer-1', caseId: 'case-1', role: 'customer', body: 'З мене списали двічі', createdAt: timestamp }] }
          return response({ caseId: 'case-1', status: 'open', ownership: 'bot', reply: null, runId: 'run-1' }, 202)
        }
        return response(conversation)
      })
      vi.stubGlobal('fetch', fetch)
      const user = userEvent.setup()
      render(<App />)
      await user.type(screen.getByRole('textbox', { name: 'Ваше повідомлення' }), 'З мене списали двічі')
      await user.click(screen.getByRole('button', { name: 'Надіслати' }))
      expect(await screen.findByText('Повідомлення прийнято. Очікуємо запуску AI…')).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Надіслати' })).toBeDisabled()
      expect(screen.queryByText('Підготували дію для погодження оператором.')).not.toBeInTheDocument()

      conversation = { ...conversation, activeRun: { id: 'run-1', status: 'running' } }
      expect(await screen.findByText('AI опрацьовує ваше повідомлення…')).toBeInTheDocument()
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1)

      conversation = { ...conversation, activeRun: null, status: 'awaiting_approval', messages: [...conversation.messages, { id: 'assistant-1', caseId: 'case-1', role: 'assistant', body: 'Підготували дію для погодження оператором.', createdAt: timestamp }] }
      expect(await screen.findByText('Підготували дію для погодження оператором.')).toBeInTheDocument()
      expect(screen.queryByText('AI опрацьовує ваше повідомлення…')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toBeEnabled()

      await user.type(screen.getByRole('textbox', { name: 'Ваше повідомлення' }), 'Моя наступна чернетка')
      conversation = { ...conversation, activeRun: { id: 'run-2', status: 'running' } }
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toBeDisabled())
      expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toHaveValue('Моя наступна чернетка')
      conversation = { ...conversation, activeRun: null }
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toBeEnabled())
      expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toHaveValue('Моя наступна чернетка')
    } finally { polling.mockRestore() }
  })

  it('accepts a staff-owned null reply without pretending an AI run is queued', async () => {
    window.history.replaceState({}, '', '/chat')
    const conversation: CustomerCase = { id: 'case-1', businessName: 'Демо-сервіс', status: 'escalated', ownership: 'staff', activeRun: null, messages: [] }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/personas')) return response([{ name: 'Олена', plan: 'Monthly', sessionToken: 'demo-olena', businessName: 'Демо-сервіс' }])
      if (path.endsWith('/chat/test-cases')) return response({ id: 'case-1', status: 'escalated', isTest: true }, 201)
      if (path.endsWith('/messages') && init?.method === 'POST') return response({ caseId: 'case-1', status: 'escalated', ownership: 'staff', reply: null, runId: null }, 202)
      return response(conversation)
    }))
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByRole('textbox', { name: 'Ваше повідомлення' }), 'Питання оператору')
    await user.click(screen.getByRole('button', { name: 'Надіслати' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toBeEnabled())
    expect(screen.queryByText('Повідомлення прийнято. Очікуємо запуску AI…')).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Ваше повідомлення' }), 'Ще одна чернетка')
    expect(screen.getByRole('button', { name: 'Надіслати' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Ваше повідомлення' })).toHaveValue('Ще одна чернетка')
  })
})

describe('business-scoped resources', () => {
  it('saves settings with their version and explicit business scope', async () => {
    operatorSession()
    window.history.replaceState({}, '', '/operator/settings?section=actions')
    const initial = { businessId: 'business-1', version: 1, language: 'uk', tone: 'empathetic', requireApproval: true, refundLimitCents: 50000, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment'] }
    let current = initial
    const fetch = mockOperator((path, init) => {
      if (path === '/api/v1/businesses') return response({ businesses: [{ id: 'business-1', name: 'Бізнес А', slug: 'a', currency: 'UAH' }] })
      if (path === '/api/v1/settings?businessId=business-1') { if (init?.method === 'PATCH') current = { ...current, ...JSON.parse(String(init.body)), version: 2 }; return response(current) }
      return undefined
    })
    const user = userEvent.setup()
    render(<App />)
    const limit = await screen.findByLabelText('Гранична сума повернення, UAH')
    await user.clear(limit)
    await user.type(limit, '250')
    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }))
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const sent = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(sent?.[0]).toBe('/api/v1/settings?businessId=business-1')
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual(expect.objectContaining({ version: 1, requireApproval: true, refundLimitCents: 25000 }))
    expect(JSON.parse(String(sent?.[1]?.body))).not.toHaveProperty('businessId')
    expect(await screen.findByText(/Налаштування збережено сервером/)).toBeInTheDocument()
  })

  it('publishes a saved source using its current version and business', async () => {
    operatorSession()
    window.history.replaceState({}, '', '/operator/knowledge')
    let source = { id: 'source-1', businessId: 'business-1', title: 'Правила повернення', category: 'Оплата', content: 'Кожне повернення проходить перевірку.', version: 1, status: 'draft', updatedAt: timestamp }
    const fetch = mockOperator(path => {
      if (path === '/api/v1/businesses') return response({ businesses: [{ id: 'business-1', name: 'Бізнес А', slug: 'a', currency: 'UAH' }] })
      if (path === '/api/v1/knowledge?businessId=business-1') return response({ sources: [source], capabilities: { create: true, update: true, publish: true, revoke: true } })
      if (path === '/api/v1/knowledge/source-1/publish?businessId=business-1') { source = { ...source, version: 2, status: 'published' }; return response(source) }
      return undefined
    })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Опублікувати' }))
    const sent = fetch.mock.calls.find(([url]) => String(url).includes('/publish?'))
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ version: 1 })
    expect(await screen.findByText('Документ опубліковано.')).toBeInTheDocument()
  })
})
