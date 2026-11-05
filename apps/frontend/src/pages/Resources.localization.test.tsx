import { render, screen, waitFor } from '../test/render'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { I18nProvider, useI18n, type Locale } from '../i18n'
import { loadAppCatalog } from '../locales/load'
import { Settings } from './Resources'

const locales = ['en', 'es', 'uk', 'de', 'pt'] as const
const businessId = '20000000-0000-4000-8000-000000000001'
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function Controls() {
  const { setLocale } = useI18n()
  return <>{locales.map(locale => <button key={locale} onClick={() => setLocale(locale)}>switch-{locale}</button>)}</>
}

it('keeps dirty settings and the two-language agent contract across all five UI languages', async () => {
  await Promise.all(locales.map(loadAppCatalog))
  let settings = { businessId, version: 1, language: 'uk', tone: 'neutral', requireApproval: true, refundLimitCents: 50000, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'], classification: null }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/businesses') return response({ businesses: [{ id: businessId, name: 'Synthetic business', currency: 'UAH', slug: 'synthetic' }] })
    if (path.startsWith('/api/v1/settings?')) {
      if (init?.method === 'PATCH') settings = { ...settings, ...JSON.parse(String(init.body)), version: settings.version + 1 }
      return response(settings)
    }
    if (path.startsWith('/api/v1/skills?')) return response({ skills: [], preset: 'support-v1' })
    if (path === '/api/v1/capabilities') return response({ runtime: 'rules', provider: 'rules', model: 'keyword-rules-v1', persistence: 'memory', paymentProvider: 'simulated', credentialsConfigured: false, knowledgeSearch: 'hybrid', maxToolCalls: 8 })
    throw new Error('Unexpected fixture endpoint')
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<I18nProvider initialLocale="uk"><Controls /><Settings token="synthetic-operator" /></I18nProvider>)
  const replyLanguage = await screen.findByLabelText('Мова відповіді')
  const limit = screen.getByLabelText('Гранична сума повернення, UAH')
  await user.selectOptions(replyLanguage, 'en')
  await user.clear(limit)
  await user.type(limit, '321.50')
  await screen.findByText('Правила')
  const reads = fetch.mock.calls.length
  const headings: Record<Locale, string> = { en: 'Settings', es: 'Configuración', uk: 'Налаштування', de: 'Einstellungen', pt: 'Definições' }
  for (const locale of locales) {
    await user.click(screen.getByRole('button', { name: `switch-${locale}` }))
    expect(await screen.findByRole('heading', { name: headings[locale] })).toBeInTheDocument()
    expect(replyLanguage).toBeInTheDocument()
    expect(replyLanguage).toHaveValue('en')
    expect(Array.from(replyLanguage.querySelectorAll('option')).map(option => option.value)).toEqual(['uk', 'en'])
    expect(limit).toHaveValue(321.5)
    expect(fetch.mock.calls).toHaveLength(reads)
  }
  await user.click(screen.getByRole('button', { name: 'Guardar alterações' }))
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1))
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(JSON.parse(String(write[1]?.body))).toEqual({ version: 1, language: 'en', tone: 'neutral', requireApproval: true, refundLimitCents: 32150, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'] })
})
