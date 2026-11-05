import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from './test/render'
import { I18nProvider, translateMessage } from './i18n'
import { loadAppCatalog } from './locales/load.ts'
import { LanguagePicker } from './components/LanguagePicker'
import { ActionCard } from './components/ActionCard'
import { CustomerChat } from './pages/CustomerChat'
import type { CaseDetail, Proposal } from './lib/api'
import * as api from './lib/api'

const time = '2026-11-04T12:00:00.000Z'
const hash = 'a'.repeat(64)
function proposal(): Proposal {
  return { id: 'proposal-synthetic', caseId: 'case-synthetic', tool: 'refund_payment', args: { payment_id: 'payment-synthetic', amount_cents: 123456 }, argsHash: hash, status: 'approved', risk: 'high', policy: { allowed: true, requiresApproval: true, checks: [] }, createdAt: time, decidedAt: null, decidedBy: null, result: null, error: null }
}
function detail(current: Proposal): CaseDetail {
  return { case: { id: 'case-synthetic', businessId: 'business-synthetic', customerId: 'customer-synthetic', customerName: 'Original customer', status: 'awaiting_approval', priority: 'P2', intent: null, analysis: null, createdAt: time, updatedAt: time }, customer: { id: 'customer-synthetic', businessId: 'business-synthetic', name: 'Original customer', email: 'synthetic@example.test', plan: 'Original plan' }, messages: [], proposals: [current], payments: [], refunds: [], audit: [], runs: [] }
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const text = (key: Parameters<typeof translateMessage>[0]['key'], locale: 'en' | 'de') => translateMessage({ key }, locale)
beforeAll(async () => { await Promise.all(['en', 'de'].map(locale => loadAppCatalog(locale as 'en' | 'de'))) })
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/operator') })

it('keeps an in-flight hash-bound execution uncertain across a language switch without enabling retries', async () => {
  const current = proposal()
  const execution = deferred<Response>()
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? execution.promise : response(detail(current)))
  vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale="en"><LanguagePicker /><ActionCard proposal={current} detail={detail(current)} token="synthetic-operator" stale={false} onChanged={vi.fn()} /></I18nProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: text('core.action.execute', 'en') }))
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
  await waitFor(() => expect(document.documentElement.lang).toBe('de'))
  execution.resolve(response({ proposal: { status: 'unknown', error: 'Original provider diagnostic' } }, 502))
  expect(await screen.findByText(text('core.action.uncertain', 'de'))).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: text('core.action.execute', 'de') })).not.toBeInTheDocument()
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ argsHash: hash })
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('uses a typed stale-action conflict in another language without POST or an uncertain-effect warning', async () => {
  const current = proposal()
  const fetch = vi.fn(async () => response(detail({ ...current, argsHash: 'b'.repeat(64) })))
  vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale="de"><ActionCard proposal={current} detail={detail(current)} token="synthetic-operator" stale={false} onChanged={vi.fn()} /></I18nProvider>)
  await userEvent.setup().click(screen.getByRole('button', { name: text('core.action.execute', 'de') }))
  expect(await screen.findByRole('alert')).toHaveTextContent(text('core.action.changed', 'de'))
  expect(screen.queryByText(text('core.action.uncertain', 'de'))).not.toBeInTheDocument()
  expect(fetch).toHaveBeenCalledOnce()
})

it('preserves an expired external approval and original business arguments when changing language', async () => {
  const current = { ...proposal(), tool: 'external_action', args: { title: 'Original business operation', integrationId: 'orders', operationKey: 'POST /orders/cancel', input: { order_id: 'original-order' }, effect: 'write', expiresAt: '2020-01-01T00:00:00.000Z' } }
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale="en"><LanguagePicker /><ActionCard proposal={current} detail={detail(current)} token="synthetic-operator" stale={false} onChanged={vi.fn()} /></I18nProvider>)
  expect(screen.getByRole('button', { name: text('core.action.execute', 'en') })).toBeDisabled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
  await waitFor(() => expect(screen.getByRole('button', { name: text('core.action.execute', 'de') })).toBeDisabled())
  expect(screen.getByRole('heading', { name: 'Original business operation' })).toBeInTheDocument()
  expect(document.querySelector('.external-action-meta')).toHaveTextContent('order_id: original-order')
  expect(current.args.input).toEqual({ order_id: 'original-order' })
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps a customer draft and stored business messages unchanged and sends only the original customer payload', async () => {
  const requests = vi.spyOn(api, 'request')
  const originalBody = 'Original stored reply: Ваша оплата вже перевірена.'
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/personas')) return response([{ name: 'Original customer', sessionToken: 'synthetic-customer', businessName: 'Original business', plan: 'Original plan' }])
    if (String(input).endsWith('/chat/cases') && init?.method === 'POST') return response({ id: 'case-synthetic' })
    if (init?.method === 'POST') return response({ caseId: 'case-synthetic', status: 'open', ownership: 'staff', reply: null })
    return response({ id: 'case-synthetic', status: 'open', businessName: 'Original business', messages: [{ id: 'message-synthetic', caseId: 'case-synthetic', role: 'assistant', body: originalBody, createdAt: time }] })
  })
  vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale="en"><CustomerChat /></I18nProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Original customer/ }))
  const draft = await screen.findByLabelText(text('core.chat.message', 'en'))
  await user.type(draft, 'Original customer text: Не перекладати 123')
  expect(await screen.findByText(originalBody)).toBeInTheDocument()
  const isConversationRead = ([path, init]: [RequestInfo | URL, RequestInit?]) => String(path).endsWith('/chat/cases/case-synthetic') && init?.method !== 'POST'
  const isResourceRead = ([path]: Parameters<typeof api.request>) => path === '/chat/cases/case-synthetic'
  const read = requests.mock.calls.find(isResourceRead)
  expect(read).toBeDefined()
  const resourceSignal = read?.[2]?.signal
  expect(resourceSignal).toBeInstanceOf(AbortSignal)
  const otherRequests = fetch.mock.calls.filter(call => !isConversationRead(call)).length
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
  await waitFor(() => expect(screen.getByLabelText(text('core.chat.message', 'de'))).toHaveValue('Original customer text: Не перекладати 123'))
  expect(screen.getByText(originalBody)).toBeInTheDocument()
  expect(fetch.mock.calls.filter(call => !isConversationRead(call))).toHaveLength(otherRequests)
  expect(resourceSignal?.aborted).toBe(false)
  // Scheduled polling may fire while the user types; a locale change must not
  // restart the resource or create a new request/cleanup controller.
  expect(requests.mock.calls.filter(isResourceRead).every(([, , options]) => options?.signal === resourceSignal)).toBe(true)
  await user.click(screen.getByRole('button', { name: text('core.common.send', 'de') }))
  const sent = fetch.mock.calls.find(([path]) => String(path).endsWith('/messages'))
  expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ body: 'Original customer text: Не перекладати 123' })
  expect(new Headers(sent?.[1]?.headers).get('X-Customer-Session')).toBe('synthetic-customer')
  expect(new Headers(sent?.[1]?.headers).has('Authorization')).toBe(false)
  await waitFor(() => expect(screen.getByLabelText(text('core.chat.message', 'de'))).toHaveValue(''))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
