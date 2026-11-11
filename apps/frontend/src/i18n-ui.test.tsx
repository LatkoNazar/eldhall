import { useEffect } from 'react'
import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { render } from './test/render'
import { I18nProvider, formatNumber, localeCodes, useI18n, type Locale } from './i18n'
import * as loader from './locales/load.ts'
import type { AppCatalog } from './locales/load.ts'
import { localeStorageKey, resolveLocale } from '../../../packages/i18n/src/core.ts'
import { LanguagePicker } from './components/LanguagePicker'
import { ErrorNotice } from './components/ErrorNotice'
import { Metric } from './components/ui'
import { ApiError } from './lib/api'
import App from './App'
import { CaseWorkspace } from './pages/Inbox'

const realLoad = loader.loadAppCatalog
const catalogs = new Map<Locale, AppCatalog>()
beforeAll(async () => { for (const locale of localeCodes) catalogs.set(locale, await realLoad(locale)) })
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/operator') })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function Probe({ mounted }: { mounted?: () => void }) {
  const { t, locale } = useI18n()
  useEffect(() => { mounted?.() }, [mounted])
  return <><LanguagePicker /><output aria-label="active locale">{locale}</output><p>{t('core.common.refresh')}</p><p data-testid="numbers">{t('core.analytics.resolvedOf', { resolved: 1234567.89, total: 2345678.91 })}</p><Metric label="Synthetic count" value={1234567.89} /><input aria-label="unchanged draft" defaultValue="Original customer text" /></>
}

it.each([
  ['en', 'Operator access key'], ['es', 'Clave de acceso del operador'], ['uk', 'Ключ доступу оператора'], ['de', 'Zugriffsschlüssel für Mitarbeitende'], ['pt', 'Chave de acesso do operador'],
] as const)('renders the actual operator entry in %s without contacting services', (locale, label) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale={locale}><App /></I18nProvider>)
  expect(screen.getByLabelText(label)).toBeInTheDocument()
  expect(document.documentElement.lang).toBe(locale)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(localeCodes)('uses the canonical number locale for interpolated notices and numeric metrics (%s)', locale => {
  render(<I18nProvider initialLocale={locale}><Probe /></I18nProvider>)
  const expected = formatNumber(1234567.89, locale)
  expect(screen.getByTestId('numbers').textContent).toContain(expected)
  expect(document.querySelector('.metric strong')?.textContent).toBe(expected)
})

it.each([
  ['en', 'Cases: 1'], ['es', 'Casos: 1'], ['uk', 'Звернення: 1'], ['de', 'Anfragen: 1'], ['pt', 'Pedidos: 1'],
] as const)('renders a grammatical single-case queue count in %s', async (locale, count) => {
  const current = { id: 'case-synthetic', businessId: 'business-synthetic', customerId: 'customer-synthetic', customerName: 'Original customer', status: 'open' as const, priority: 'P2', intent: null, analysis: null, createdAt: '2026-11-04T12:00:00.000Z', updatedAt: '2026-11-04T12:00:00.000Z' }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ case: current, customer: { id: 'customer-synthetic', businessId: 'business-synthetic', name: 'Original customer', email: 'synthetic@example.test', plan: 'Original plan' }, messages: [], proposals: [], payments: [], refunds: [], audit: [], runs: [] }), { headers: { 'Content-Type': 'application/json' } })))
  render(<I18nProvider initialLocale={locale}><CaseWorkspace token="synthetic-operator" cases={[current]} search="" actionOnly={false} onChanged={vi.fn()} /></I18nProvider>)
  expect(await screen.findByRole('heading', { name: 'Original customer' })).toBeInTheDocument()
  expect(screen.getByText(count, { selector: '.list-caption small' })).toBeInTheDocument()
})

it('only commits the newest loaded language without remounting or changing the form draft', async () => {
  const late = deferred<AppCatalog>()
  vi.spyOn(loader, 'loadAppCatalog').mockImplementation(locale => locale === 'es' ? late.promise : realLoad(locale))
  const mounted = vi.fn()
  render(<I18nProvider initialLocale="en"><Probe mounted={mounted} /></I18nProvider>)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'es' } })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
  expect(await screen.findByText('Aktualisieren')).toBeInTheDocument()
  await act(async () => { late.resolve(catalogs.get('es')!); await late.promise })
  expect(screen.getByLabelText('active locale')).toHaveTextContent('de')
  expect(document.documentElement.lang).toBe('de')
  expect(localStorage.getItem(localeStorageKey)).toBe('de')
  expect(new URL(location.href).searchParams.get('lang')).toBe('de')
  expect(screen.getByLabelText('unchanged draft')).toHaveValue('Original customer text')
  expect(mounted).toHaveBeenCalledOnce()
})

it('keeps the previous locale, URL, storage and draft on a rejected chunk and allows a real-catalog retry', async () => {
  const load = vi.spyOn(loader, 'loadAppCatalog').mockRejectedValueOnce(new Error('synthetic private chunk failure'))
  render(<I18nProvider initialLocale="en"><Probe /></I18nProvider>)
  const beforeUrl = location.href
  const beforeStored = localStorage.getItem(localeStorageKey)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pt' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('The language could not be loaded. Try again.')
  expect(screen.getByLabelText('active locale')).toHaveTextContent('en')
  expect(location.href).toBe(beforeUrl); expect(localStorage.getItem(localeStorageKey)).toBe(beforeStored)
  expect(screen.queryByText('synthetic private chunk failure')).not.toBeInTheDocument()
  load.mockImplementation(realLoad)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pt' } })
  expect(await screen.findByText('Atualizar')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByLabelText('unchanged draft')).toHaveValue('Original customer text')
})

it('ignores a late language result after unmount without writing its preference or URL', async () => {
  const late = deferred<AppCatalog>()
  vi.spyOn(loader, 'loadAppCatalog').mockReturnValue(late.promise)
  const view = render(<I18nProvider initialLocale="en"><Probe /></I18nProvider>)
  const beforeUrl = location.href; const beforeStored = localStorage.getItem(localeStorageKey)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
  view.unmount()
  await act(async () => { late.resolve(catalogs.get('de')!); await late.promise })
  expect(location.href).toBe(beforeUrl); expect(localStorage.getItem(localeStorageKey)).toBe(beforeStored)
  expect(document.documentElement.lang).toBe('en')
})

it('persists an initial query preference so a fresh same-origin chat retains it', () => {
  history.replaceState({}, '', '/operator?lang=es')
  const locale = resolveLocale({ url: location.href, browserLanguages: ['uk-UA'] })
  render(<I18nProvider initialLocale={locale}><Probe /></I18nProvider>)
  expect(localStorage.getItem(localeStorageKey)).toBe('es')
  expect(resolveLocale({ url: '/chat', storedLocale: localStorage.getItem(localeStorageKey), browserLanguages: ['uk-UA'] })).toBe('es')
})

it('switches languages during a pending key check without revalidating, changing the key or showing authenticated content', async () => {
  const pending = deferred<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise); vi.stubGlobal('fetch', fetch)
  render(<I18nProvider initialLocale="en"><App /></I18nProvider>)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Operator access key'), 'synthetic-operator-key')
  await user.selectOptions(screen.getByRole('combobox'), 'es')
  expect(await screen.findByLabelText('Clave de acceso del operador')).toHaveValue('synthetic-operator-key')
  await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }))
  expect(fetch).toHaveBeenCalledOnce()
  await user.selectOptions(screen.getByRole('combobox'), 'de')
  expect(await screen.findByText('Zugriffsschlüssel wird geprüft…')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledOnce()
  expect(screen.queryByRole('heading', { name: 'Eingehende Anfragen' })).not.toBeInTheDocument()
  const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined
  expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-operator-key' })
  await act(async () => { pending.resolve(new Response(JSON.stringify({ detail: 'Invalid operator token' }), { status: 401, headers: { 'Content-Type': 'application/json' } })); await pending.promise })
  expect(await screen.findByRole('alert')).toHaveTextContent('Der Schlüssel ist ungültig oder abgelaufen.')
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it('localizes the primary API error while preserving original server text as escaped secondary data', async () => {
  const error = new ApiError(409, 'Synthetic original detail <script>', undefined, undefined, 'Synthetic original detail <script>')
  render(<I18nProvider initialLocale="en"><LanguagePicker /><ErrorNotice error={error} /></I18nProvider>)
  await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'de')
  expect(await screen.findByRole('alert')).toHaveTextContent('Der Zustand hat sich geändert.')
  expect(screen.getByText('Synthetic original detail <script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
})
