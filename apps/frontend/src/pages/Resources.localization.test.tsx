import { databasePolicyFixture } from '../test/database-investigation-fixtures'
import { guardFixture } from '../test/banking-fixtures'
import { render, screen, waitFor } from '../test/render'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { I18nProvider, useI18n, type Locale } from '../i18n'
import { restoreAccent } from '../lib/accent'
import { loadAppCatalog } from '../locales/load'
import { Settings } from './Settings'

const locales = ['en', 'es', 'uk', 'de', 'pt'] as const
const businessId = '20000000-0000-4000-8000-000000000001'
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function Controls() {
  const { setLocale } = useI18n()
  return <>{locales.map(locale => <button key={locale} onClick={() => setLocale(locale)}>switch-{locale}</button>)}</>
}

function mockSettings() {
  let settings = { businessId, version: 1, language: 'uk', tone: 'neutral', requireApproval: true, refundLimitCents: 50000, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'], classification: null }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/workspace') return response({ business: { id: businessId, name: 'Synthetic business', currency: 'UAH', slug: 'synthetic' } })
    if (path.startsWith('/api/v1/settings?')) {
      if (init?.method === 'PATCH') settings = { ...settings, ...JSON.parse(String(init.body)), version: settings.version + 1 }
      return response(settings)
    }
    if (path.startsWith('/api/v1/guards/database?')) return response(databasePolicyFixture())
    if (path.startsWith('/api/v1/guards?')) return response(guardFixture())
    if (path.startsWith('/api/v1/skills?')) return response({ skills: [], preset: 'support-v1' })
    if (path === '/api/v1/capabilities') return response({ runtime: 'rules', provider: 'rules', model: 'keyword-rules-v1', persistence: 'memory', paymentProvider: 'simulated', credentialsConfigured: false, knowledgeSearch: 'hybrid', maxToolCalls: 8 })
    throw new Error('Unexpected fixture endpoint')
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('changes the accent from Settings and restores it on the next page load', async () => {
  history.replaceState({}, '', '/operator/settings?lang=uk')
  const fetch = mockSettings()
  const user = userEvent.setup()
  const root = document.documentElement
  try {
    restoreAccent()
    const view = render(<Settings token="synthetic-operator" />)
    await user.click(screen.getByRole('link', { name: 'Вигляд' }))
    const red = screen.getByRole('radio', { name: 'Червоний' })
    expect(red).toBeChecked()
    red.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Синій' })).toBeChecked()
    expect(root.dataset.accent).toBe('blue')
    view.unmount()

    delete root.dataset.accent
    restoreAccent()
    render(<Settings token="synthetic-operator" />)
    expect(screen.getByRole('radio', { name: 'Синій' })).toBeChecked()
    expect(root.dataset.accent).toBe('blue')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    localStorage.removeItem('eldhall.accent')
    delete root.dataset.accent
  }
})

it('keeps a section open and preserves its draft across all five UI languages', async () => {
  await Promise.all(locales.map(loadAppCatalog))
  history.replaceState({}, '', '/operator/settings?section=actions')
  const fetch = mockSettings()
  const user = userEvent.setup()
  render(<I18nProvider initialLocale="uk"><Controls /><Settings token="synthetic-operator" /></I18nProvider>)
  const limit = await screen.findByLabelText('Гранична сума повернення, UAH')
  await user.clear(limit)
  await user.type(limit, '321.50')
  expect(screen.queryByLabelText('Мова відповіді')).not.toBeInTheDocument()
  expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(['/api/v1/workspace', `/api/v1/settings?businessId=${businessId}`])
  const reads = fetch.mock.calls.length
  const backLabels: Record<Locale, string> = { en: 'Settings', es: 'Configuración', uk: 'Налаштування', de: 'Einstellungen', pt: 'Definições' }
  for (const locale of locales) {
    await user.click(screen.getByRole('button', { name: `switch-${locale}` }))
    expect(await screen.findByRole('link', { name: backLabels[locale] })).toHaveAttribute('href', `/operator/settings?lang=${locale}`)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(limit).toHaveValue(321.5)
    expect(fetch.mock.calls).toHaveLength(reads)
  }
  await user.click(screen.getByRole('button', { name: 'Guardar alterações' }))
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1))
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(JSON.parse(String(write[1]?.body))).toEqual({ version: 1, language: 'uk', tone: 'neutral', requireApproval: true, refundLimitCents: 32150, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'] })
})

it('opens a section from the list and protects a draft when using its back arrow', async () => {
  history.replaceState({}, '', '/operator/settings?lang=uk')
  const fetch = mockSettings()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  const user = userEvent.setup()
  render(<Settings token="synthetic-operator" />)

  expect(screen.getByRole('navigation', { name: 'Налаштування' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Відповіді' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Мова відповіді')).not.toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
  await user.click(screen.getByRole('link', { name: 'Дії' }))

  const limit = await screen.findByLabelText('Гранична сума повернення, UAH')
  expect(screen.queryByLabelText('Тон спілкування')).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  await user.clear(limit)
  await user.type(limit, '350')

  const back = screen.getByRole('link', { name: 'Налаштування' })
  await user.click(back)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(limit).toHaveValue(350)
  expect(new URLSearchParams(location.search).get('section')).toBe('actions')

  await user.click(back)
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('navigation', { name: 'Налаштування' })).toBeInTheDocument()
  expect(screen.queryByLabelText('Мова відповіді')).not.toBeInTheDocument()
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/skills?'))).toBe(false)

  await user.click(screen.getByRole('link', { name: 'Навички' }))
  await screen.findByRole('heading', { name: 'Навички помічника' })
  expect(screen.queryByLabelText('Мова відповіді')).not.toBeInTheDocument()
  expect(new URLSearchParams(location.search).get('section')).toBe('skills')
  expect(new URLSearchParams(location.search).get('lang')).toBe('uk')
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/guards?') || String(path).includes('/guards/database?'))).toBe(false)

  history.back()
  expect(await screen.findByRole('navigation', { name: 'Налаштування' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Навички помічника' })).not.toBeInTheDocument()
})
