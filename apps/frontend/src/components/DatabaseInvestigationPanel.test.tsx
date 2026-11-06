import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../test/render'
import { databasePolicyFixture } from '../test/database-investigation-fixtures'
import { I18nProvider, useI18n, translateMessage } from '../i18n'
import { loadAppCatalog } from '../locales/load'
import { DatabaseInvestigationPanel } from './DatabaseInvestigationPanel'

const businessId = '20000000-0000-4000-8000-000000000001'
const path = `/api/v1/guards/database?businessId=${businessId}`
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const label = (key: Parameters<typeof translateMessage>[0]['key']) => translateMessage({ key }, 'uk')

it('saves only versioned policy fields after an explicit edit, with immutable scope facts', async () => {
  const config = databasePolicyFixture()
  const fetch = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => response(options?.method === 'PUT' ? { ...config, ...JSON.parse(String(options.body)), version: 2 } : config))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
  const enabled = await screen.findByRole('checkbox', { name: label('bank.database.enabled') })
  expect(enabled).not.toBeChecked()
  expect(screen.getByLabelText(label('bank.database.maxQueriesPerTurn'))).toHaveValue(8)
  expect(screen.getByLabelText(label('bank.database.timeoutMs'))).toHaveValue(2000)
  expect(screen.getByLabelText(label('bank.database.maxRows'))).toHaveValue(100)
  expect(screen.getByLabelText(label('bank.database.maxBytes'))).toHaveValue(32768)
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(1)
  await user.click(enabled)
  fireEvent.change(screen.getByLabelText(label('bank.database.maxRows')), { target: { value: '150' } })
  expect(fetch).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: label('bank.database.save') }))
  expect(await screen.findByText(label('bank.database.saved'))).toBeVisible()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1]![0]).toBe(path)
  expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer synthetic-operator')
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ version: 1, enabled: true, limits: { ...config.limits, maxRows: 150 } })
})

it('keeps a lost-update draft and requires explicit latest-version review before a second PUT', async () => {
  const config = databasePolicyFixture()
  let writes = 0
  const fetch = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'PUT') return ++writes === 1 ? response({ detail: 'Version conflict' }, 409) : response({ ...config, ...JSON.parse(String(options.body)), version: 3 })
    return response(writes ? { ...config, version: 2, limits: { ...config.limits, maxRows: 75 } } : config)
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
  const rows = await screen.findByLabelText(label('bank.database.maxRows'))
  fireEvent.change(rows, { target: { value: '120' } })
  await user.click(screen.getByRole('button', { name: label('bank.database.save') }))
  expect(await screen.findByText(label('bank.database.conflict'))).toBeVisible()
  expect(rows).toHaveValue(120)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: label('bank.database.save') })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: label('requests.reviewLatest') }))
  const latest = await screen.findByRole('region', { name: label('bank.database.latest') })
  expect(latest).toHaveTextContent('75')
  expect(rows).toHaveValue(120)
  expect(writes).toBe(1)
  await user.click(screen.getByRole('button', { name: label('bank.database.keepDraft') }))
  expect(rows).toHaveValue(120)
  expect(writes).toBe(1)
  await user.click(screen.getByRole('button', { name: label('bank.database.save') }))
  await screen.findByText(label('bank.database.saved'))
  expect(JSON.parse(String(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')[1]![1]?.body))).toEqual({ version: 2, enabled: false, limits: { ...config.limits, maxRows: 120 } })
})

it('cannot enable an unconfigured source, and fails closed on an unsafe scope response', async () => {
  const config = databasePolicyFixture()
  const fetch = vi.fn().mockResolvedValue(response({ ...config, sources: [] }))
  vi.stubGlobal('fetch', fetch)
  const view = render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
  expect(await screen.findByText(label('bank.database.noSources'))).toBeVisible()
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(screen.getByRole('button', { name: label('bank.database.save') })).toBeDisabled()
  expect(fetch).toHaveBeenCalledTimes(1)
  view.unmount()
  fetch.mockResolvedValue(response({ ...config, constraints: { readOnly: false, scope: 'current_customer' } }))
  render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

it('rejects out-of-bound and empty limits even if form submission bypasses native validity', async () => {
  const fetch = vi.fn().mockResolvedValue(response(databasePolicyFixture()))
  vi.stubGlobal('fetch', fetch)
  render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
  const rows = await screen.findByLabelText(label('bank.database.maxRows'))
  for (const value of ['201', '', '1.5']) {
    fireEvent.change(rows, { target: { value } })
    expect(screen.getByRole('button', { name: label('bank.database.save') })).toBeDisabled()
    fireEvent.submit(rows.closest('form')!)
    expect(fetch).toHaveBeenCalledTimes(1)
  }
})

function LocaleControls() {
  const { setLocale } = useI18n()
  return <>{(['en', 'es', 'uk', 'de', 'pt'] as const).map(locale => <button key={locale} onClick={() => setLocale(locale)}>switch-{locale}</button>)}</>
}
it('preserves the draft across all five languages without replaying reads or writes', async () => {
  const locales = ['en', 'es', 'uk', 'de', 'pt'] as const
  await Promise.all(locales.map(loadAppCatalog))
  const fetch = vi.fn().mockResolvedValue(response(databasePolicyFixture()))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<I18nProvider initialLocale="uk"><LocaleControls /><DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} /></I18nProvider>)
  const rows = await screen.findByLabelText(label('bank.database.maxRows'))
  fireEvent.change(rows, { target: { value: '125' } })
  for (const locale of locales) {
    await user.click(screen.getByRole('button', { name: `switch-${locale}` }))
    await waitFor(() => expect(screen.getByRole('heading', { name: translateMessage({ key: 'bank.database.title' }, locale) })).toBeVisible())
    expect(rows).toHaveValue(125)
    expect(fetch).toHaveBeenCalledTimes(1)
  }
})

it('disables edits and writes in the isolated read-only inspector mode', async () => {
  vi.stubEnv('MODE', 'inspector-demo')
  try {
    const fetch = vi.fn().mockResolvedValue(response(databasePolicyFixture()))
    vi.stubGlobal('fetch', fetch)
    render(<DatabaseInvestigationPanel token="synthetic-operator" businessId={businessId} />)
    expect(await screen.findByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: label('bank.database.save') })).toBeDisabled()
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllEnvs() }
})
