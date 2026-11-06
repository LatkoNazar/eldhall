import { render as renderRaw } from '@testing-library/react'
import { I18nProvider, useI18n, translateMessage, type Locale } from '../i18n'
import { loadAppCatalog } from '../locales/load'
import { act, render, screen, waitFor, within } from '../test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { Integrations } from './Integrations'
import App from '../App'
import { navigate } from '../lib/navigation'
import type { CatalogOperation, IntegrationPolicy, IntegrationSummary, PolicyOperationUpdate } from '../lib/integrations-api'

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
function mockApi(options: { conflict?: boolean; conflictingGroups?: boolean; reviewedInherited?: boolean; changedDefinition?: boolean; unknownEffect?: boolean } = {}) {
  const currentSummary = summary()
  const currentPolicy = policy()
  const currentOperations = operations()
  if (options.reviewedInherited) {
    Object.assign(currentOperations[1]!, { enabled: true, reviewedOperationHash: currentOperations[1]!.operationHash, effective: { mode: 'ask', source: 'group', matchedRuleIds: ['orders'], policyRevision: 1, reasonCode: 'group_rule' } })
    Object.assign(currentPolicy.operations[1]!, { enabled: true, reviewedOperationHash: currentOperations[1]!.operationHash })
  }
  if (options.changedDefinition) currentOperations[0]!.operationHash = 'd'.repeat(64)
  if (options.unknownEffect) currentOperations[1]!.effect = 'unknown'
  if (options.conflictingGroups) currentOperations[0]!.effective = { mode: 'deny', source: 'group', matchedRuleIds: ['billing', 'orders'], policyRevision: 1, reasonCode: 'group_conflict_strictest' }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/workspace') return response({ business: { id: businessId, name: 'First Store', slug: 'fixture-bank', currency: 'UAH' } })
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
      const body = JSON.parse(String(init.body)) as { defaultMode?: IntegrationPolicy['defaultMode']; groups?: IntegrationPolicy['groups']; operations?: PolicyOperationUpdate[]; manifestHash?: string }
      if (options.conflict) {
        currentSummary.version = 2; currentSummary.policyRevision = 2; currentPolicy.groups[0]!.mode = 'auto'
        return response({ detail: 'Policy version conflict' }, 409)
      }
      if (url.pathname.endsWith('/policy')) {
        if (body.defaultMode) currentPolicy.defaultMode = body.defaultMode
        if (body.groups) currentPolicy.groups = body.groups
        for (const change of body.operations ?? []) {
          const rule = currentPolicy.operations.find(item => item.operationKey === change.operationKey)!
          const operation = currentOperations.find(item => item.operationKey === change.operationKey)!
          rule.mode = operation.mode = change.mode
          if (change.mode === 'deny') { rule.enabled = operation.enabled = false; rule.reviewedOperationHash = operation.reviewedOperationHash = null }
          else if ((change.mode === 'ask' || change.mode === 'auto') && body.manifestHash === hash && change.operationHash === operation.operationHash) { rule.enabled = operation.enabled = true; rule.reviewedOperationHash = operation.reviewedOperationHash = operation.operationHash }
          operation.effective = operation.enabled ? { mode: change.mode === 'inherit' ? 'deny' : change.mode, source: 'operation', matchedRuleIds: [change.operationKey], policyRevision: currentSummary.policyRevision + 1, reasonCode: 'operation_rule' } : { mode: 'deny', source: 'guard', matchedRuleIds: [], policyRevision: currentSummary.policyRevision + 1, reasonCode: 'operation_disabled' }
        }
      }
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
})

async function openGroup(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByRole('combobox', { name: 'Дозвіл групи orders' })) {
    await user.click(await screen.findByLabelText('Дії інтеграції'))
    await user.click(screen.getByRole('button', { name: 'Розширені налаштування' }))
  }
  return screen.findByRole('combobox', { name: 'Дозвіл групи orders' })
}
async function openTools(user: ReturnType<typeof userEvent.setup>) {
  const back = screen.queryByRole('button', { name: 'Назад до інструментів' })
  if (back) await user.click(back)
}
function selectedMode(title: string) {
  return within(screen.getByRole('group', { name: `Дозвіл операції ${title}` })).getByRole('radio', { checked: true }).getAttribute('value')
}
async function openOperation(user: ReturnType<typeof userEvent.setup>, title: string) {
  await openTools(user)
  await screen.findByRole('group', { name: `Дозвіл операції ${title}` })
  const control = screen.getAllByRole('button').find(button => button.hasAttribute('aria-expanded') && button.textContent?.includes(title))!
  if (control.getAttribute('aria-expanded') !== 'true') await user.click(control)
  return control.closest('article')!
}

it('waits for operator login before requesting integration data on a direct route', async () => {
  sessionStorage.clear()
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<App />)
  expect(fetch).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('Ключ доступу оператора'), 'operator-key')
  await user.click(screen.getByRole('button', { name: /Відкрити робочий простір/ }))
  expect(await screen.findByRole('heading', { name: 'Інтеграції' })).toBeInTheDocument()
  await openGroup(user)
  expect(fetch.mock.calls.some(([path]) => String(path) === `/api/v1/integrations?businessId=${businessId}`)).toBe(true)
  sessionStorage.clear()
})

it('preserves endpoint overrides when changing a group and sends business-scoped CAS edits', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  await screen.findByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })
  expect(selectedMode('Перевірити замовлення')).toBe('auto')
  const normalRow = screen.getByRole('group', { name: 'Дозвіл операції Перевірити замовлення' }).closest('article')!
  expect(normalRow.querySelector('.integration-tool-state')).toBeNull()
  expect(within(normalRow).getByText('Auto — автоматично — власне правило')).not.toBeVisible()
  const group = await openGroup(user)
  group.focus()
  expect(group).toHaveFocus()
  await user.selectOptions(group, 'deny')
  await openTools(user)
  expect(selectedMode('Перевірити замовлення')).toBe('auto')
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await screen.findByText('Сервер зберіг зміни. Ефективні дозволи перечитано.')
  const mutation = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(mutation[0]).toBe(`/api/v1/integrations/orders/policy?businessId=${businessId}`)
  expect(new Headers(mutation[1]?.headers).get('Authorization')).toBe('Bearer operator-key')
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ version: 1, groups: [{ id: 'orders', mode: 'deny' }, { id: 'billing', mode: 'deny' }], operations: [] })
  const row = await openOperation(user, 'Перевірити замовлення')
  expect(within(row).getByText('Auto — автоматично — власне правило')).toBeVisible()
  await user.click(within(row).getByText(translateMessage({ key: 'operations.integrations.exactDefinition' }, 'uk'), { selector: 'summary' }))
  await user.click(screen.getByRole('button', { name: 'Скинути до успадкування Перевірити замовлення' }))
  expect(selectedMode('Перевірити замовлення')).toBe('deny')
  expect(group).toHaveValue('deny')
})

it('saves explicit access with exact current pins atomically and revokes it through the same control', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  const modes = await screen.findByRole('group', { name: 'Дозвіл операції Скасувати замовлення' })
  expect(selectedMode('Скасувати замовлення')).toBe('deny')
  expect(screen.getByRole('button', { name: 'Зберегти правила' })).toBeDisabled()
  await user.click(within(modes).getByRole('radio', { name: 'Auto — автоматично' }))
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'POST')).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await screen.findByText('Сервер зберіг зміни. Ефективні дозволи перечитано.')
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  expect(writes()).toHaveLength(1)
  expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({ version: 1, manifestHash: hash, defaultMode: 'deny', groups: policy().groups, operations: [{ operationKey: 'POST /orders/{order_id}/cancel', mode: 'auto', operationHash: 'c'.repeat(64) }] })
  expect(selectedMode('Скасувати замовлення')).toBe('auto')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/review?'))).toBe(false)
  await openOperation(user, 'Скасувати замовлення')
  expect(screen.queryByRole('button', { name: /Переглянути й увімкнути|Вимкнути операцію/ })).not.toBeInTheDocument()
  await user.click(within(modes).getByRole('radio', { name: 'Deny — заборонено' }))
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await waitFor(() => expect(writes()).toHaveLength(2))
  expect(JSON.parse(String(writes()[1]![1]?.body))).toEqual({ version: 2, defaultMode: 'deny', groups: policy().groups, operations: [{ operationKey: 'POST /orders/{order_id}/cancel', mode: 'deny' }] })
})

it('keeps stale edits locked after 409 until the operator explicitly reloads current policy', async () => {
  const fetch = mockApi({ conflict: true })
  const user = userEvent.setup()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<Integrations token="operator-key" />)
  await user.selectOptions(await openGroup(user), 'deny')
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Конфлікт версій')
  expect(screen.getByRole('combobox', { name: 'Дозвіл групи orders' })).toHaveValue('deny')
  expect(screen.getByRole('button', { name: 'Зберегти правила' })).toBeDisabled()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Перечитати поточну політику' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByRole('combobox', { name: 'Дозвіл групи orders' })).toHaveValue('auto')
})

it('shows group conflicts and preserves already reviewed inheritance without guessing effective permissions', async () => {
  const user = userEvent.setup()
  mockApi({ conflictingGroups: true, reviewedInherited: true })
  render(<Integrations token="operator-key" />)
  const modes = await screen.findByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })
  const restriction = modes.closest('article')!.querySelector<HTMLElement>('.integration-tool-state')!
  expect(within(restriction).getByText('Deny — заборонено — успадковано від billing, orders')).toBeVisible()
  await openOperation(user, 'Перевірити замовлення')
  expect(await screen.findByText(/Конфлікт груп: billing, orders/)).toBeVisible()
  expect(screen.getByText('Deny — заборонено — успадковано від billing, orders')).toBeInTheDocument()
  expect(selectedMode('Скасувати замовлення')).toBe('ask')
  await openOperation(user, 'Скасувати замовлення')
  expect(screen.getByText(/Успадковане правило/)).toBeVisible()
})

it('keeps the bank binding under a foreign business URL and retains dirty-policy navigation guards', async () => {
  history.replaceState({}, '', '/operator/integrations?businessId=' + otherBusiness)
  const fetch = mockApi()
  const user = userEvent.setup()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Integrations token="operator-key" />)
  const group = await openGroup(user)
  expect(screen.queryByLabelText('Бізнес інтеграцій')).not.toBeInTheDocument()
  expect(screen.getByText(/Посилання вказує інший бізнес/)).toBeInTheDocument()
  await user.selectOptions(group, 'deny')
  act(() => { expect(navigate('/operator/knowledge')).toBe(false) })
  expect(confirm).toHaveBeenCalledOnce()
  expect(group).toHaveValue('deny')
  expect(fetch.mock.calls.some(([path]) => String(path).includes('businessId=' + otherBusiness))).toBe(false)
  expect(fetch.mock.calls.some(([path]) => String(path) === '/api/v1/integrations/orders/operations?businessId=' + businessId)).toBe(true)
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
  expect(screen.getByRole('combobox', { name: 'Інтеграція' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Підключити API' })).toBeEnabled()
  expect(original.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'POST')).toBe(false)
})

it('blocks permissions when the server omits the operation definition', async () => {
  const original = mockApi()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await original(input, init)
    const value = await result.json()
    if (String(input).includes('/operations?')) delete value.operations[0].inputSchema
    return response(value)
  }))
  render(<Integrations token="operator-key" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Некоректна структура відповіді сервера.')
  expect(screen.queryByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })).not.toBeInTheDocument()
})

it('guards dirty policy edits and releases both unload and navigation guards when clean or unmounted', async () => {
  mockApi()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const user = userEvent.setup()
  const view = render(<Integrations token="operator-key" />)
  const group = await openGroup(user)
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

function LocaleControls() {
  const { setLocale } = useI18n()
  return <>{(['en', 'es', 'uk', 'de', 'pt'] as const).map(locale => <button key={locale} onClick={() => setLocale(locale)}>switch-{locale}</button>)}</>
}

it('switches all five interface languages without losing a dirty policy or replaying a request', async () => {
  const locales = ['en', 'es', 'uk', 'de', 'pt'] as const
  await Promise.all(locales.map(loadAppCatalog))
  const fetch = mockApi()
  const user = userEvent.setup()
  renderRaw(<I18nProvider initialLocale="uk"><LocaleControls /><Integrations token="operator-key" /></I18nProvider>)
  const group = await openGroup(user)
  await user.selectOptions(group, 'deny')
  const reads = fetch.mock.calls.length
  const headings: Record<Locale, string> = { en: 'Integrations', es: 'Integraciones', uk: 'Інтеграції', de: 'Integrationen', pt: 'Integrações' }
  for (const locale of locales) {
    await user.click(screen.getByRole('button', { name: `switch-${locale}` }))
    expect(await screen.findByRole('heading', { name: headings[locale] })).toBeInTheDocument()
    expect(group).toBeInTheDocument()
    expect(group).toHaveValue('deny')
    expect(fetch.mock.calls).toHaveLength(reads)
  }
  await user.click(screen.getByRole('button', { name: 'Guardar regras' }))
  expect(await screen.findByText('O servidor guardou as alterações. As permissões efetivas foram recarregadas.')).toBeInTheDocument()
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  expect(writes).toHaveLength(1)
  const payload = JSON.parse(String(writes[0]![1]?.body))
  expect(payload.version).toBe(1)
  expect(payload.groups.find((item: { id: string }) => item.id === 'orders')).toMatchObject({ selector: { tag: 'Orders' }, mode: 'deny' })
  const completedRequests = fetch.mock.calls.length
  await user.click(screen.getByRole('button', { name: 'switch-en' }))
  expect(await screen.findByText('The server saved the changes. Effective permissions were reloaded.')).toBeInTheDocument()
  expect(fetch.mock.calls).toHaveLength(completedRequests)
})

it('keeps settings navigation read-only and disables only through an explicit versioned menu action', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  const actions = await screen.findByLabelText('Дії інтеграції')
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
  expect(screen.queryByRole('combobox', { name: 'Дозвіл групи orders' })).not.toBeInTheDocument()
  await user.click(actions)
  await user.keyboard('{Escape}')
  expect(actions.closest('details')).not.toHaveAttribute('open')
  expect(actions).toHaveFocus()
  await user.click(actions)
  await user.click(screen.getByRole('textbox', { name: 'Пошук операцій' }))
  expect(actions.closest('details')).not.toHaveAttribute('open')
  await openGroup(user)
  expect(screen.getByRole('heading', { name: 'Розширені налаштування' })).toHaveFocus()
  expect(within(screen.getByRole('group', { name: 'Типовий дозвіл інтеграції' })).getByRole('radio', { checked: true }).getAttribute('value')).toBe('deny')
  expect(writes()).toHaveLength(0)
  await openTools(user)
  expect(actions).toHaveFocus()
  expect(await screen.findByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })).toBeVisible()
  await user.click(actions)
  await user.click(screen.getByRole('button', { name: 'Вимкнути інтеграцію' }))
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(writes()[0]![0]).toBe(`/api/v1/integrations/orders/disable?businessId=${businessId}`)
  expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({ version: 1, draining: false })
  await user.click(screen.getByRole('button', { name: 'Підключити API' }))
  await user.click(await screen.findByRole('button', { name: 'Скасувати' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Підключити API' })).toHaveFocus())
  expect(writes()).toHaveLength(1)
})

it('keeps new and changed definitions denied when only default and group permissions change', async () => {
  const fetch = mockApi({ changedDefinition: true })
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  await screen.findByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })
  expect(selectedMode('Перевірити замовлення')).toBe('deny')
  expect(selectedMode('Скасувати замовлення')).toBe('deny')
  expect(screen.getByRole('button', { name: 'Зберегти правила' })).toBeDisabled()
  const group = await openGroup(user)
  await user.selectOptions(group, 'auto')
  await user.click(within(screen.getByRole('group', { name: 'Типовий дозвіл інтеграції' })).getByRole('radio', { name: 'Auto — автоматично' }))
  await openTools(user)
  expect(selectedMode('Перевірити замовлення')).toBe('deny')
  expect(selectedMode('Скасувати замовлення')).toBe('deny')
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  await screen.findByText('Сервер зберіг зміни. Ефективні дозволи перечитано.')
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  const body = JSON.parse(String(write[1]?.body))
  expect(body).toMatchObject({ defaultMode: 'auto', operations: [] })
  expect(body.manifestHash).toBeUndefined()
  expect(selectedMode('Перевірити замовлення')).toBe('deny')
  expect(selectedMode('Скасувати замовлення')).toBe('deny')
})

it('keeps unknown-effect operations blocked and preserves an explicit access draft after a stale save', async () => {
  const fetch = mockApi({ unknownEffect: true, conflict: true })
  const user = userEvent.setup()
  render(<Integrations token="operator-key" />)
  const unknown = await screen.findByRole('group', { name: 'Дозвіл операції Скасувати замовлення' })
  expect(selectedMode('Скасувати замовлення')).toBe('deny')
  for (const radio of within(unknown).getAllByRole('radio')) expect(radio).toBeDisabled()
  const known = screen.getByRole('group', { name: 'Дозвіл операції Перевірити замовлення' })
  await user.click(within(known).getByRole('radio', { name: 'Ask — через погодження' }))
  await user.click(screen.getByRole('button', { name: 'Зберегти правила' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Конфлікт версій')
  expect(selectedMode('Перевірити замовлення')).toBe('ask')
  expect(screen.getByRole('button', { name: 'Зберегти правила' })).toBeDisabled()
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  expect(writes).toHaveLength(1)
  expect(JSON.parse(String(writes[0]![1]?.body))).toMatchObject({ version: 1, manifestHash: hash, operations: [{ operationKey: 'GET /orders/{order_id}', mode: 'ask', operationHash }] })
})
