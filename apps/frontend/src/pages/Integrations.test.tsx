import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { Integrations } from './Integrations'
import App from '../App'
import { navigate } from '../lib/navigation'
import type { CatalogOperation, IntegrationPolicy, IntegrationSummary } from '../lib/integrations-api'

const businessId = '20000000-0000-4000-8000-000000000001'
const otherBusiness = '20000000-0000-4000-8000-000000000002'
const hash = 'a'.repeat(64)
const operationHash = 'b'.repeat(64)
const time = '2026-11-04T10:00:00.000Z'
const summary = (): IntegrationSummary => ({ businessId, integrationId: 'orders', enabled: true, draining: false, activeManifestHash: hash, loadedManifestHash: hash, connectionRevision: '1', policyRevision: 1, version: 1, defaultMode: 'deny', updatedAt: time })
const policy = (): IntegrationPolicy => ({ businessId, integrationId: 'orders', enabled: true, manifestHash: hash, policyRevision: 1, defaultMode: 'deny', groups: [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'ask' }, { id: 'billing', selector: { tag: 'Billing' }, mode: 'deny' }], operations: [{ operationKey: 'GET /orders/{order_id}', enabled: true, reviewedOperationHash: operationHash, mode: 'auto' }, { operationKey: 'POST /orders/{order_id}/cancel', enabled: false, reviewedOperationHash: null, mode: 'inherit' }] })
const operations = (): CatalogOperation[] => [
  { operationKey: 'GET /orders/{order_id}', operationId: 'getOrderStatus', toolName: 'getOrderStatus', method: 'GET', path: '/orders/{order_id}', title: 'Перевірити замовлення', description: 'Статус замовлення поточного клієнта.', tags: ['Orders', 'Billing'], effect: 'read', operationHash, enabled: true, reviewedOperationHash: operationHash, mode: 'auto', effective: { mode: 'auto', source: 'operation', matchedRuleIds: ['GET /orders/{order_id}'], policyRevision: 1, reasonCode: 'operation_rule' }, inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false }, parameters: { order_id: 'path' }, outputFields: ['status'], scope: { customerId: { in: 'query', name: 'customer_id' } } },
  { operationKey: 'POST /orders/{order_id}/cancel', operationId: 'cancelOrder', toolName: 'cancelOrder', method: 'POST', path: '/orders/{order_id}/cancel', title: 'Скасувати замовлення', description: 'Скасування лише після перевірки власника й стану.', tags: ['Orders'], effect: 'write', operationHash: 'c'.repeat(64), enabled: false, reviewedOperationHash: null, mode: 'inherit', effective: { mode: 'deny', source: 'guard', matchedRuleIds: [], policyRevision: 1, reasonCode: 'operation_disabled' }, inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false }, parameters: { order_id: 'path' }, scope: { customerId: { in: 'query', name: 'customer_id' } }, outputFields: ['status'], guard: 'orders.cancel', idempotency: { header: 'Idempotency-Key' } },
]
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function mockApi(options: { conflict?: boolean; conflictingGroups?: boolean } = {}) {
  const currentSummary = summary()
  const currentPolicy = policy()
  const currentOperations = operations()
  if (options.conflictingGroups) currentOperations[0]!.effective = { mode: 'deny', source: 'group', matchedRuleIds: ['billing', 'orders'], policyRevision: 1, reasonCode: 'group_conflict_strictest' }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/operator/session') return response({ authenticated: true })
    if (path === '/api/v1/cases') return response([])
    if (path === '/api/v1/metrics') return response({ cases: 0, byStatus: { open: 0, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: { P1: 0, P2: 0, P3: 0 }, proposals: {}, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null })
    if (path === '/api/v1/businesses') return response({ businesses: [{ id: businessId, name: 'First Store', currency: 'UAH' }, { id: otherBusiness, name: 'Second Store', currency: 'EUR' }] })
    const url = new URL(path, window.location.origin)
    const scope = url.searchParams.get('businessId') ?? businessId
    const scopedSummary = () => ({ ...currentSummary, businessId: scope })
    if (url.pathname === '/api/v1/integrations') return response({ integrations: [scopedSummary()] })
    if (url.pathname.endsWith('/operations')) return response({ integration: scopedSummary(), groups: currentPolicy.groups, operations: currentOperations })
    if (init?.method && ['PATCH', 'POST'].includes(init.method)) {
      const body = JSON.parse(String(init.body)) as { defaultMode?: IntegrationPolicy['defaultMode']; groups?: IntegrationPolicy['groups']; operations?: IntegrationPolicy['operations'] }
      if (options.conflict) {
        currentSummary.version = 2; currentSummary.policyRevision = 2; currentPolicy.groups[0]!.mode = 'auto'
        return response({ detail: 'Policy version conflict' }, 409)
      }
      if (url.pathname.endsWith('/policy')) { if (body.defaultMode) currentPolicy.defaultMode = body.defaultMode; if (body.groups) currentPolicy.groups = body.groups; if (body.operations) currentPolicy.operations = currentPolicy.operations.map(rule => ({ ...rule, mode: body.operations?.find(change => change.operationKey === rule.operationKey)?.mode ?? rule.mode })) }
      if (url.pathname.endsWith('/review')) { currentOperations[1]!.enabled = true; currentOperations[1]!.reviewedOperationHash = currentOperations[1]!.operationHash }
      currentSummary.version++; currentSummary.policyRevision++; currentPolicy.policyRevision++
      return response({ integration: scopedSummary(), policy: { ...currentPolicy, businessId: scope } })
    }
    if (url.pathname.endsWith('/policy')) return response({ integration: scopedSummary(), policy: { ...currentPolicy, businessId: scope } })
    return response({ detail: 'Unexpected endpoint' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
beforeEach(() => {
  window.history.replaceState({}, '', '/operator/integrations')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
})

it('waits for operator login before requesting integration data on a direct route', async () => {
  sessionStorage.clear()
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<App />)
  expect(fetch).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('Ключ доступу оператора'), 'operator-key')
  await user.click(screen.getByRole('button', { name: /Відкрити робочий простір/ }))
  expect(await screen.findByRole('heading', { name: 'Інтеграції' })).toBeInTheDocument()
  await screen.findByRole('combobox', { name: 'Дозвіл групи orders' })
  expect(fetch.mock.calls.some(([path]) => String(path) === `/api/v1/integrations?businessId=${businessId}`)).toBe(true)
  sessionStorage.clear()
})

it('preserves endpoint overrides when changing a group and sends business-scoped CAS edits', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  const group = await screen.findByRole('combobox', { name: 'Дозвіл групи orders' })
  expect(screen.getByLabelText('Дозвіл операції Перевірити замовлення')).toHaveValue('auto')
  group.focus()
  expect(group).toHaveFocus()
  await user.selectOptions(group, 'deny')
  expect(screen.getByLabelText('Дозвіл операції Перевірити замовлення')).toHaveValue('auto')
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await screen.findByText('Сервер зберіг зміни. Ефективні дозволи перечитано.')
  const mutation = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(mutation[0]).toBe(`/api/v1/integrations/orders/policy?businessId=${businessId}`)
  expect(new Headers(mutation[1]?.headers).get('Authorization')).toBe('Bearer operator-key')
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ version: 1, groups: [{ id: 'orders', mode: 'deny' }, { id: 'billing', mode: 'deny' }], operations: [{ operationKey: 'GET /orders/{order_id}', mode: 'auto' }, { operationKey: 'POST /orders/{order_id}/cancel', mode: 'inherit' }] })
  await user.click(screen.getByRole('button', { name: 'Скинути до успадкування Перевірити замовлення' }))
  expect(screen.getByLabelText('Дозвіл операції Перевірити замовлення')).toHaveValue('inherit')
  expect(screen.getByRole('combobox', { name: 'Дозвіл групи orders' })).toHaveValue('deny')
})

it('keeps review separate from Auto and submits only an explicitly reviewed exact hash', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  await user.selectOptions(await screen.findByLabelText('Дозвіл операції Скасувати замовлення'), 'auto')
  expect(screen.getByRole('button', { name: 'Переглянути й увімкнути Скасувати замовлення' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Переглянути й увімкнути Скасувати замовлення' })).toBeEnabled())
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/review?'))).toBe(false)
  expect(screen.getByText('Вимкнено — операцію ще не активовано')).toBeInTheDocument()
  const opener = screen.getByRole('button', { name: 'Переглянути й увімкнути Скасувати замовлення' })
  await user.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Перегляд: Скасувати замовлення' })
  expect(within(dialog).getByText(/"operationHash": "cccc/)).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Підтвердити review і ввімкнути' })).toBeDisabled()
  await user.click(within(dialog).getByRole('checkbox'))
  await user.click(within(dialog).getByRole('button', { name: 'Підтвердити review і ввімкнути' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  const review = fetch.mock.calls.find(([path]) => String(path).includes('/review?'))!
  expect(JSON.parse(String(review[1]?.body))).toEqual({ version: 2, manifestHash: hash, operations: [{ operationKey: 'POST /orders/{order_id}/cancel', operationHash: 'c'.repeat(64), enabled: true }] })
  expect(opener).toHaveFocus()
})

it('keeps stale edits locked after 409 until the operator explicitly reloads current policy', async () => {
  const fetch = mockApi({ conflict: true })
  const user = userEvent.setup()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<Integrations token="operator-key" />)
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Дозвіл групи orders' }), 'deny')
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Конфлікт версій')
  expect(screen.getByRole('combobox', { name: 'Дозвіл групи orders' })).toHaveValue('deny')
  expect(screen.getByRole('button', { name: 'Зберегти правила' })).toBeDisabled()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Перечитати поточну політику' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByRole('combobox', { name: 'Дозвіл групи orders' })).toHaveValue('auto')
})

it('shows group conflicts, explicit inheritance and disabled reviewed state without guessing effective permissions', async () => {
  mockApi({ conflictingGroups: true })
  render(<Integrations token="operator-key" />)
  expect(await screen.findByText(/Конфлікт груп: billing, orders/)).toBeInTheDocument()
  expect(screen.getByText('Deny — успадковано від billing, orders')).toBeInTheDocument()
  expect(screen.getByLabelText('Дозвіл операції Скасувати замовлення')).toHaveValue('inherit')
  expect(screen.getByText('Потрібен review поточної версії')).toBeInTheDocument()
})

it('discards only with permission when switching business and reads the new business catalog', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Integrations token="operator-key" />)
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Дозвіл групи orders' }), 'deny')
  await user.selectOptions(screen.getByLabelText('Бізнес інтеграцій'), otherBusiness)
  expect(screen.getByLabelText('Бізнес інтеграцій')).toHaveValue(businessId)
  confirm.mockReturnValue(true)
  await user.selectOptions(screen.getByLabelText('Бізнес інтеграцій'), otherBusiness)
  await screen.findByRole('combobox', { name: 'Дозвіл групи orders' })
  expect(fetch.mock.calls.some(([path]) => String(path) === `/api/v1/integrations/orders/operations?businessId=${otherBusiness}`)).toBe(true)
})

it('blocks editing when separately read catalog and policy versions do not match', async () => {
  const original = mockApi()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await original(input, init)
    const value = await result.json()
    if (String(input).includes('/policy?')) value.integration.version++
    return response(value)
  }))
  render(<Integrations token="operator-key" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Каталог змінився під час читання')
  expect(screen.queryByRole('button', { name: 'Зберегти правила' })).not.toBeInTheDocument()
  expect(original.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'POST')).toBe(false)
})

it('does not offer review when the server omits the operation definition', async () => {
  const original = mockApi()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await original(input, init)
    const value = await result.json()
    if (String(input).includes('/operations?')) delete value.operations[0].inputSchema
    return response(value)
  }))
  render(<Integrations token="operator-key" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Некоректний каталог або політика')
  expect(screen.queryByRole('button', { name: /Переглянути й увімкнути/ })).not.toBeInTheDocument()
})

it('guards dirty policy edits and releases both unload and navigation guards when clean or unmounted', async () => {
  mockApi()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const user = userEvent.setup()
  const view = render(<Integrations token="operator-key" />)
  const group = await screen.findByRole('combobox', { name: 'Дозвіл групи orders' })
  const unloadIsPrevented = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  expect(unloadIsPrevented()).toBe(false)
  await user.selectOptions(group, 'deny')
  expect(unloadIsPrevented()).toBe(true)
  act(() => { expect(navigate('/operator/team')).toBe(false) })
  expect(confirm).toHaveBeenCalledOnce()
  expect(group).toHaveValue('deny')
  await user.selectOptions(group, 'ask')
  expect(unloadIsPrevented()).toBe(false)
  await user.selectOptions(group, 'deny')
  expect(unloadIsPrevented()).toBe(true)
  view.unmount()
  expect(unloadIsPrevented()).toBe(false)
  act(() => { expect(navigate('/operator/team')).toBe(true) })
  expect(confirm).toHaveBeenCalledOnce()
})
