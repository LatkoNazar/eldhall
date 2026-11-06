import { databasePolicyFixture } from '../test/database-investigation-fixtures'
import { act, render, screen, waitFor, within } from '../test/render'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { WorkspaceProvider } from './WorkspaceProvider'
import { SkillsPanel } from './SkillsPanel'
import { GuardsPanel } from './GuardsPanel'
import { AgentActivity } from './AgentActivity'
import { requestFixture, uuid } from '../test/request-fixtures'
import { guardFixture, skillFixture, workspaceBusiness, bankingTime } from '../test/banking-fixtures'
import { LanguagePicker } from './LanguagePicker'
import { loadAppCatalog } from '../locales/load'

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

it('waits for authenticated authoritative workspace metadata and never lets a foreign URL retarget resources', async () => {
  history.replaceState({}, '', '/operator/settings?businessId=foreign-bank')
  let finish!: (value: Response) => void
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/v1/workspace' ? new Promise<Response>(resolve => { finish = resolve }) : response({ skills: [], preset: 'support-v1' }))
  vi.stubGlobal('fetch', fetch)
  render(<WorkspaceProvider token="synthetic-operator">{business => <><h1>{business.name}</h1><SkillsPanel token="synthetic-operator" businessId={business.id} /></>}</WorkspaceProvider>)
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('heading', { name: workspaceBusiness.name })).not.toBeInTheDocument()
  await act(async () => finish(response({ business: workspaceBusiness })))
  expect(await screen.findByRole('heading', { name: workspaceBusiness.name })).toBeInTheDocument()
  expect(await screen.findByText(/Посилання вказує інший бізнес/)).toBeInTheDocument()
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(['/api/v1/workspace', `/api/v1/skills?businessId=${workspaceBusiness.id}`])
  expect(screen.queryByRole('combobox', { name: 'Бізнес' })).not.toBeInTheDocument()
})

it.each([
  { payload: { detail: 'Choose an explicit workspace', code: 'workspace_ambiguous' }, status: 409 },
  { payload: { business: { id: workspaceBusiness.id, name: 'Malformed workspace' } }, status: 200 },
])('fails closed on unavailable or malformed workspace metadata without loading child resources ($status)', async ({ payload, status }) => {
  const fetch = vi.fn().mockResolvedValue(response(payload, status))
  vi.stubGlobal('fetch', fetch)
  render(<WorkspaceProvider token="synthetic-operator">{business => <h1>{business.name}</h1>}</WorkspaceProvider>)
  expect(await screen.findByRole('heading', { name: 'Робочий простір недоступний' })).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('heading', { name: workspaceBusiness.name })).not.toBeInTheDocument()
})

it('clears the old workspace while a different authenticated credential binding is being checked', async () => {
  let finish!: (value: Response) => void
  let reads = 0
  const fetch = vi.fn(async () => ++reads === 1 ? response({ business: workspaceBusiness }) : new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const child = (business: typeof workspaceBusiness) => <h1>{business.name}</h1>
  const view = render(<WorkspaceProvider token="first-credential">{child}</WorkspaceProvider>)
  expect(await screen.findByRole('heading', { name: workspaceBusiness.name })).toBeInTheDocument()
  view.rerender(<WorkspaceProvider token="next-credential">{child}</WorkspaceProvider>)
  expect(screen.queryByRole('heading', { name: workspaceBusiness.name })).not.toBeInTheDocument()
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await act(async () => finish(response({ business: { ...workspaceBusiness, id: uuid(999), name: 'Second authorized bank' } })))
  expect(await screen.findByRole('heading', { name: 'Second authorized bank' })).toBeInTheDocument()
})

it('edits a stable skill by exact revision, keeps its draft on409 and never retries a write automatically', async () => {
  let stored = skillFixture()
  const fetch = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'PATCH') { stored = { ...stored, revision: 2, content: 'Concurrent reviewed instructions.' }; return response({ detail: 'Skill revision changed' }, 409) }
    return response({ skills: [stored], preset: 'support-v1' })
  })
  vi.stubGlobal('fetch', fetch)
  render(<SkillsPanel token="synthetic-operator" businessId={workspaceBusiness.id} />)
  await userEvent.setup().click(await screen.findByText(/custom\/customer-support/))
  const content = screen.getByLabelText('Інструкція')
  await userEvent.setup().clear(content); await userEvent.setup().type(content, 'Reviewed banking support instructions.')
  await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Використовувати skill у наступних запусках агента' }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Зберегти зміни skill' }))
  expect(await screen.findByText(/Збережена ревізія змінилася/)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Переглянути актуальну версію' })).toBeEnabled())
  expect(content).toHaveValue('Reviewed banking support instructions.')
  expect(screen.getByLabelText(/Актуальна збережена інструкція/)).toHaveValue('Concurrent reviewed instructions.')
  const writes = fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')
  expect(writes).toHaveLength(1)
  expect(writes[0]![0]).toBe(`/api/v1/skills/${stored.id}?businessId=${workspaceBusiness.id}`)
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ revision: 1, content: 'Reviewed banking support instructions.', enabled: false })
  expect(screen.getByRole('button', { name: 'Зберегти зміни skill' })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Переглянути актуальну версію' }))
  expect(screen.getByRole('button', { name: 'Зберегти зміни skill' })).toBeEnabled()
  expect(content).toHaveValue('Reviewed banking support instructions.')
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1)
})

it('saves only supported structured guards with exact configurationCAS and preserves conflicts', async () => {
  const config = guardFixture()
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).includes('/guards/database?')) return response(databasePolicyFixture())
    if (options?.method === 'PUT') { config.version = 2; return response({ detail: 'Settings version changed' }, 409) }
    return response(config)
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<GuardsPanel token="synthetic-operator" businessId={workspaceBusiness.id} currency="UAH" />)
  await user.click(await screen.findByRole('button', { name: 'Додати обмеження' }))
  expect(screen.getByRole('button', { name: 'Зберегти обмеження' })).toBeDisabled()
  await user.type(screen.getByLabelText('Назва правила'), 'High-value refund ceiling')
  await user.selectOptions(screen.getByLabelText('Тип правила'), 'amount_limit')
  await user.clear(screen.getByLabelText('Гранична сума в мінімальних одиницях (копійках)'))
  await user.type(screen.getByLabelText('Гранична сума в мінімальних одиницях (копійках)'), '25000')
  expect(Array.from(screen.getByLabelText('Цільова дія').querySelectorAll('option')).map(option => option.value)).toEqual(['refund_payment'])
  await user.type(screen.getByLabelText('Підстава в перевірках дії'), 'Specialist review required for larger refunds.')
  await user.click(screen.getByRole('button', { name: 'Зберегти обмеження' }))
  expect(await screen.findByText(/Конфігурація змінилася/)).toBeInTheDocument()
  expect(screen.getByLabelText('Назва правила')).toHaveValue('High-value refund ceiling')
  const writes = fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')
  expect(writes).toHaveLength(1)
  expect(JSON.parse(String(writes[0]![1]!.body))).toMatchObject({ version: 1, rules: [{ kind: 'amount_limit', target: { tool: 'refund_payment' }, maxAmountCents: 25000, currency: 'UAH', enabled: true, definitionVersion: 1 }] })
  expect(screen.getByRole('button', { name: 'Зберегти обмеження' })).toBeDisabled()
})

it('shows only recorded public call/result/decision fields and filters requests by explicit links', async () => {
  const detail = requestFixture()
  detail.agentActivity = { status: 'recorded', hasMore: true, events: [{ id: uuid(701), runId: uuid(710), sequence: 1, turnJobId: uuid(711), callId: 'recorded-call-1', createdAt: bankingTime, type: 'tool_result', tool: 'lookup_payments', outcome: 'succeeded', summary: 'One matching customer payment was returned.', reason: 'Recorded scoped payment lookup.', proposalId: null, requestIds: [uuid(3)], input: { limit: 10 }, result: { paymentCount: 1 }, checks: [], context: { settingsVersion: 1, guardRevision: 2, skills: [{ id: uuid(601), name: 'custom/customer-support', revision: 2, contentHash: 'a'.repeat(64), preview: 'Recorded instructions', truncated: false, loadedCharacters: 21, totalCharacters: 21 }], guards: [], provider: 'rules', model: 'keyword-rules-v1' } }] }
  Object.assign(detail.agentActivity.events[0]!, { privateChainOfThought: 'DO_NOT_RENDER_PRIVATE_REASONING' })
  render(<AgentActivity detail={detail} selectedRequestId={uuid(1)} />)
  const user = userEvent.setup()
  await user.click(screen.getByText('Дії агента'))
  expect(screen.getByText('One matching customer payment was returned.')).toBeInTheDocument()
  expect(screen.queryByText('DO_NOT_RENDER_PRIVATE_REASONING')).not.toBeInTheDocument()
  await user.click(screen.getByText('Зафіксований результат'))
  expect(screen.getByText('paymentCount')).toBeInTheDocument()
  expect(within(screen.getByText('paymentCount').parentElement!).getByText('1')).toBeInTheDocument()
  await user.click(screen.getByText('Контекст запуску'))
  expect(screen.getByText('Завантажено 21 із 21 символів')).toBeInTheDocument()
  expect(screen.getByText('Recorded instructions')).toBeInTheDocument()
  expect(screen.getByText('SHA-256: ' + 'a'.repeat(64))).toBeInTheDocument()
  expect(screen.getByText(/останні 100/)).toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: /Лише явні зв’язки із R-01/ }))
  expect(screen.queryByText('One matching customer payment was returned.')).not.toBeInTheDocument()
  expect(screen.getByText('Для цього перегляду немає зафіксованих подій.')).toBeInTheDocument()
})

it('does not fabricate historical call inputs/results from old tool-name metadata', async () => {
  const detail = requestFixture()
  detail.runs = [{ id: uuid(720), provider: 'rules', model: 'fixture', status: 'ok', steps: 1, toolCalls: ['lookup_payments'], latencyMs: 20, error: null, createdAt: bankingTime }]
  render(<AgentActivity detail={detail} selectedRequestId={null} />)
  await userEvent.setup().click(screen.getByText('Дії агента'))
  expect(screen.getByText(/історичний запуск не має докладного журналу/)).toBeInTheDocument()
  expect(screen.queryByText('Вхідні дані інструмента')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByText('Збережені дані запусків'))
  expect(within(screen.getByText('lookup_payments').closest('li')!).getByText('lookup_payments')).toBeInTheDocument()
})

it('keeps skill and guard drafts across all five interface languages without requests or writes on language changes', async () => {
  const locales = ['en', 'es', 'uk', 'de', 'pt'] as const
  await Promise.all(locales.map(loadAppCatalog))
  const fetch = vi.fn(async (input: RequestInfo | URL) => response(String(input).includes('/guards/database?') ? databasePolicyFixture() : String(input).includes('/guards?') ? guardFixture() : { skills: [skillFixture()], preset: 'support-v1' }))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<><LanguagePicker /><SkillsPanel token="synthetic-operator" businessId={workspaceBusiness.id} /><GuardsPanel token="synthetic-operator" businessId={workspaceBusiness.id} currency="UAH" /></>)
  await user.click(await screen.findByText(/custom\/customer-support/))
  const content = screen.getByLabelText('Інструкція')
  await user.type(content, ' Keep this draft.')
  await user.click(await screen.findByRole('button', { name: 'Додати обмеження' }))
  const name = screen.getByLabelText('Назва правила')
  await user.type(name, 'Preserve this rule')
  const picker = screen.getByRole('combobox', { name: 'Мова інтерфейсу' })
  const calls = fetch.mock.calls.length
  const titles = { en: 'Action guards', es: 'Controles de acciones', uk: 'Обмеження дій', de: 'Aktionsregeln', pt: 'Regras de ações' }
  for (const locale of locales) {
    await user.selectOptions(picker, locale)
    expect(await screen.findByRole('heading', { name: titles[locale] })).toBeInTheDocument()
    expect(content).toHaveValue('Use recorded customer facts. Keep this draft.')
    expect(name).toHaveValue('Preserve this rule')
    expect(fetch).toHaveBeenCalledTimes(calls)
  }
})
