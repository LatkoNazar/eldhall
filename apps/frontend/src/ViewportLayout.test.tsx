import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { render } from './test/render'
import { CaseWorkspace } from './pages/Inbox'
import * as api from './lib/api'
import { translateMessage } from './i18n'
import { Dashboard } from './pages/Dashboard'

const time = '2026-11-04T12:00:00.000Z'
const ticket: api.SupportCase = { id: 'case-synthetic', businessId: 'business-synthetic', customerId: 'customer-synthetic', customerName: 'Original customer', status: 'open', priority: 'P2', intent: null, analysis: null, ownership: 'staff', createdAt: time, updatedAt: time }
const detail: api.CaseDetail = { case: ticket, customer: { id: 'customer-synthetic', businessId: 'business-synthetic', name: 'Original customer', email: 'synthetic@example.test', plan: 'Original plan' }, messages: [{ id: 'message-synthetic', caseId: ticket.id, body: 'Original business message', role: 'customer', createdAt: time }], proposals: [], payments: [], refunds: [], audit: [], runs: [] }
const label = (key: Parameters<typeof translateMessage>[0]['key']) => translateMessage({ key }, 'uk')
beforeEach(() => {
  history.replaceState({}, '', '/operator')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail), { headers: { 'Content-Type': 'application/json' } })))
})

it('keeps the selected case, draft and polling resource mounted while compact panels and queue access change', async () => {
  const requests = vi.spyOn(api, 'request')
  const user = userEvent.setup()
  const view = render(<CaseWorkspace token="synthetic-operator" cases={[ticket]} search="" actionOnly={false} onChanged={vi.fn()} />)
  const reply = await screen.findByLabelText(/Відповідь клієнту/)
  const queueItem = view.container.querySelector<HTMLButtonElement>('.case-item')!
  await user.click(queueItem)
  const conversation = screen.getByRole('button', { name: label('core.inbox.conversationPanel') })
  expect(conversation).toHaveFocus()
  await user.type(reply, 'Original unsent draft')
  const context = screen.getByRole('button', { name: label('core.inbox.context') })
  expect(context).toHaveAttribute('aria-expanded', 'false')
  await user.click(context)
  expect(context).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: label('core.inbox.resume') })).toBeInTheDocument()
  await user.click(context)
  expect(context).toHaveAttribute('aria-expanded', 'false')
  const outerSignal = requests.mock.calls.find(([path]) => path === '/cases/case-synthetic')?.[2]?.signal
  expect(outerSignal).toBeInstanceOf(AbortSignal)
  await user.click(screen.getByRole('button', { name: label('core.inbox.copilot') }))
  expect(view.container.querySelector('.inbox-layout')).toHaveAttribute('data-panel', 'inspector')
  expect(reply).toBeInTheDocument()
  await user.click(conversation)
  expect(screen.getByLabelText(/Відповідь клієнту/)).toBe(reply)
  expect(reply).toHaveValue('Original unsent draft')
  expect(screen.getByText('Original business message')).toBeInTheDocument()
  expect(outerSignal?.aborted).toBe(false)
  expect(requests.mock.calls.every(([, , options]) => options?.signal === outerSignal)).toBe(true)
  expect(requests.mock.calls.some(([, , options]) => options?.method === 'POST')).toBe(false)
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await user.click(view.container.querySelector<HTMLButtonElement>('.workspace-queue-back')!)
  expect(view.container.querySelector('.inbox-layout')).not.toHaveClass('mobile-detail-open')
  expect(queueItem).toHaveFocus()
  expect(reply).toHaveValue('Original unsent draft')
})

it('opens a case deep link directly in the compact conversation without requiring another selection', async () => {
  history.replaceState({}, '', '/operator?caseId=case-synthetic')
  const view = render(<CaseWorkspace token="synthetic-operator" cases={[ticket]} search="" actionOnly={false} onChanged={vi.fn()} />)
  expect(await screen.findByText('Original business message')).toBeInTheDocument()
  expect(view.container.querySelector('.inbox-layout')).toHaveClass('mobile-detail-open')
  await waitFor(() => expect(screen.getByRole('button', { name: label('core.inbox.conversationPanel') })).toHaveFocus())
})

it('returns keyboard focus to the queue region when polling removes the selected filtered case', async () => {
  const user = userEvent.setup()
  const view = render(<CaseWorkspace token="synthetic-operator" cases={[ticket]} search="" actionOnly={false} onChanged={vi.fn()} />)
  await screen.findByText('Original business message')
  await user.click(view.container.querySelector<HTMLButtonElement>('.case-item')!)
  view.rerender(<CaseWorkspace token="synthetic-operator" cases={[]} search="" actionOnly={false} onChanged={vi.fn()} />)
  await user.click(view.container.querySelector<HTMLButtonElement>('.workspace-queue-back')!)
  expect(screen.getByRole('region', { name: label('core.inbox.queue') })).toHaveFocus()
  expect(view.container.querySelector('.case-item')).toBeNull()
})

it('resets the internal page scroller on a route change while preserving it on a language change', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    const value = path.endsWith('/cases') ? [] : path.endsWith('/team') ? { members: [], capabilities: { invite: false, updateRole: false } } : { cases: 0, byStatus: { open: 0, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: {}, proposals: {}, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null }
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  }))
  const user = userEvent.setup()
  const view = render(<Dashboard token="synthetic-operator" location="/operator/team" onLogout={vi.fn()} />)
  const main = view.container.querySelector('main')!
  main.scrollTop = 200
  view.rerender(<Dashboard token="synthetic-operator" location="/operator/analytics" onLogout={vi.fn()} />)
  await waitFor(() => expect(main.scrollTop).toBe(0))
  expect(view.container.querySelector('main')).toBe(main)
  main.scrollTop = 200
  await user.selectOptions(screen.getByRole('combobox', { name: 'Мова інтерфейсу' }), 'en')
  expect(await screen.findByRole('heading', { name: 'Support analytics' })).toBeInTheDocument()
  expect(main.scrollTop).toBe(200)
})
