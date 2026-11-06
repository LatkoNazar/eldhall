import { act, render, screen, waitFor, within } from '../../test/render'
import { render as renderRaw } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider, translateMessage, useI18n, type AppMessageKey } from '../../i18n'
import { loadAppCatalog } from '../../locales/load'
import { IntegrationImportWizard } from './IntegrationImportWizard'
import { importBusiness, importCapabilities, importPreview, importResult } from '../../test/integration-import-fixtures'
import type { ImportPreview } from '../../lib/integration-imports-api'

const label = (key: AppMessageKey) => translateMessage({ key }, 'uk')
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function server(options: { preview?: ImportPreview; enabled?: boolean; prepareError?: { code: string; detail: string; status: number }; confirm?: (body: unknown, index: number) => Response | Promise<Response> } = {}) {
  let confirmations = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === `/api/v1/integration-imports/capabilities?businessId=${importBusiness}`) return response({ ...importCapabilities, enabled: options.enabled ?? true })
    if (path === `/api/v1/integration-imports/prepare?businessId=${importBusiness}`) return options.prepareError ? response(options.prepareError, options.prepareError.status) : response(options.preview ?? importPreview())
    if (path === `/api/v1/integration-imports/30000000-0000-4000-8000-000000000001/confirm?businessId=${importBusiness}`) return options.confirm ? options.confirm(JSON.parse(String(init?.body)), confirmations++) : response(importResult())
    throw new Error('Unexpected synthetic import endpoint')
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(label('onboarding.openapi')), 'https://api.bank.example/openapi.json')
  await user.selectOptions(screen.getByLabelText(label('onboarding.profile')), 'bank-profile')
  await user.click(screen.getByRole('button', { name: label('onboarding.preview') }))
  await screen.findByRole('heading', { name: label('onboarding.previewTitle') })
}
async function completeReviews(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Read balance' }), 'read')
  await user.selectOptions(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' }), 'write')
}
const modeGroup = (title: string) => screen.getByRole('group', { name: translateMessage({ key: 'onboarding.modeFor', values: { operation: title } }, 'uk') })
const confirmButton = () => screen.getByRole('button', { name: label('onboarding.connect') })
beforeEach(() => { history.replaceState({}, '', '/operator/integrations'); sessionStorage.clear(); localStorage.clear() })

it('previews a real server request without granting access, then sends one reviewed confirmation with exclusive keyboard modes', async () => {
  const fetch = server(); const connected = vi.fn(); const user = userEvent.setup()
  render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={connected} />)
  await prepare(user)
  const preparation = fetch.mock.calls.find(([path]) => String(path).includes('/prepare?'))!
  expect(JSON.parse(String(preparation[1]?.body))).toEqual({ integrationId: 'api-api.bank.example', specUrl: 'https://api.bank.example/openapi.json', credentialProfileId: 'bank-profile' })
  expect(new Headers(preparation[1]?.headers).get('Authorization')).toBe('Bearer synthetic-operator')
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Read balance' })).toHaveValue('unknown')
  expect(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' })).toHaveValue('unknown')
  expect(within(modeGroup('Unsupported trace')).getByRole('radio', { name: label('core.mode.deny') })).toBeDisabled()
  expect(confirmButton()).toBeDisabled()
  const readDeny = within(modeGroup('Read balance')).getByRole('radio', { name: label('core.mode.deny') })
  readDeny.focus(); await user.keyboard('{ArrowRight}{ArrowRight}')
  expect(within(modeGroup('Read balance')).getByRole('radio', { name: label('core.mode.auto') })).toBeChecked()
  expect(within(modeGroup('Read balance')).getAllByRole('radio').filter(radio => (radio as HTMLInputElement).checked)).toHaveLength(1)
  await user.click(within(modeGroup('Freeze card')).getByRole('radio', { name: label('core.mode.ask') }))
  await completeReviews(user)
  expect(confirmButton()).toBeDisabled()
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/confirm?'))).toBe(false)
  await user.click(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') }))
  await user.click(confirmButton())
  expect(await screen.findByText(label('onboarding.complete'))).toBeInTheDocument()
  const confirmation = fetch.mock.calls.find(([path]) => String(path).includes('/confirm?'))!
  const body = JSON.parse(String(confirmation[1]?.body))
  expect(body).toMatchObject({ version: 2, specHash: 'a'.repeat(64), operations: [
    { operationKey: 'GET /accounts/{account_id}/balance', mode: 'auto', review: { effect: 'read', scope: { customerId: { in: 'header', name: 'X-Customer-Id' }, businessId: { in: 'header', name: 'X-Business-Id' } }, outputFields: ['balance_cents', 'currency', 'receipt_id'] } },
    { operationKey: 'POST /accounts/{account_id}/freeze', mode: 'ask', review: { effect: 'write', idempotency: { header: 'Idempotency-Key' } } },
    { operationKey: 'TRACE /unsupported', mode: 'deny' },
  ] })
  expect(body.operations[2]).not.toHaveProperty('review')
  expect(connected).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: label('onboarding.openCatalog') }))
  expect(connected).toHaveBeenCalledOnce()
})

it('requires supported Deny definitions too, exposes source fields safely and does not pretend an unsupported tool is reviewed', async () => {
  const fetch = server(); const user = userEvent.setup()
  const view = render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await prepare(user)
  await user.selectOptions(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Read balance' }), 'read')
  expect(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: label('onboarding.reviewNext') }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' })).toHaveFocus())
  await user.selectOptions(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' }), 'write')
  const original = 'Original API description <script> is plain text.'
  await user.click(screen.getByRole('button', { name: /^GET .*Read balance/ }))
  expect(screen.getByText(original)).toBeInTheDocument(); expect(view.container.querySelector('script')).toBeNull()
  expect(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })).toBeEnabled()
  await user.click(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })); await user.click(confirmButton())
  await screen.findByText(label('onboarding.complete'))
  const sent = JSON.parse(String(fetch.mock.calls.find(([path]) => String(path).includes('/confirm?'))![1]?.body))
  expect(sent.operations.every((row: { mode: string }) => row.mode === 'deny')).toBe(true)
  expect(sent.operations.slice(0, 2).every((row: { review?: unknown }) => !!row.review)).toBe(true)
  expect(sent.operations[2]).not.toHaveProperty('review')
})

it('preserves a saved-disabled result and retries only the identical explicit confirmation', async () => {
  const bodies: unknown[] = []
  const fetch = server({ confirm: (body, index) => { bodies.push(body); return response(importResult(index > 0)) } })
  const user = userEvent.setup()
  render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await prepare(user); await completeReviews(user)
  await user.click(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })); await user.click(confirmButton())
  expect(await screen.findByText(label('onboarding.savedDisabled'))).toBeInTheDocument()
  expect(bodies).toHaveLength(1)
  expect(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: label('onboarding.retryConnection') }))
  await screen.findByText(label('onboarding.complete'))
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0])
  expect(fetch.mock.calls.filter(([path]) => String(path).includes('/prepare?'))).toHaveLength(1)
})

it('stops stale previews after 409 and never replays a mutation on rerender', async () => {
  const fetch = server({ confirm: () => response({ code: 'prepared_identity_mismatch', detail: 'private synthetic upstream error' }, 409) })
  const user = userEvent.setup()
  const view = render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await prepare(user); await completeReviews(user)
  await user.click(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })); await user.click(confirmButton())
  expect(await screen.findByRole('alert')).toHaveTextContent(label('onboarding.previewChanged'))
  expect(screen.queryByText('private synthetic upstream error')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: label('onboarding.retryConnection') })).toBeDisabled()
  view.rerender(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  expect(fetch.mock.calls.filter(([path]) => String(path).includes('/confirm?'))).toHaveLength(1)
})

it('locks an uncertain confirmation to its exact payload until an explicit retry succeeds', async () => {
  const bodies: unknown[] = []
  server({ confirm: (body, index) => { bodies.push(body); return index === 0 ? response({ code: 'managed_unavailable', detail: 'private internal diagnostic' }, 503) : response(importResult()) } })
  const user = userEvent.setup()
  const view = render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await prepare(user); await completeReviews(user)
  await user.click(screen.getByRole('checkbox', { name: label('onboarding.confirmAll') })); await user.click(confirmButton())
  expect(await screen.findByRole('alert')).toHaveTextContent(label('onboarding.error.runtime'))
  expect(screen.queryByText('private internal diagnostic')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: label('onboarding.effect') + ' Freeze card' })).toBeDisabled()
  expect(within(modeGroup('Read balance')).getByRole('radio', { name: label('core.mode.auto') })).toBeDisabled()
  view.rerender(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  expect(bodies).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: label('onboarding.retryConnection') }))
  await screen.findByText(label('onboarding.complete'))
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0])
})

it('makes expired and deployment-disabled previews honest without issuing confirm requests', async () => {
  const value = importPreview(); value.expiresAt = new Date(Date.now() - 1000).toISOString()
  const fetch = server({ preview: value }); const user = userEvent.setup()
  render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await prepare(user)
  expect(await screen.findByRole('alert')).toHaveTextContent(label('onboarding.expired'))
  expect(confirmButton()).toBeDisabled()
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/confirm?'))).toBe(false)
})

it('does not invent authentication profiles or offer URL requests when onboarding is disabled', async () => {
  const fetch = server({ enabled: false })
  render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  expect(await screen.findByText(label('onboarding.unavailable'))).toBeInTheDocument()
  expect(screen.queryByLabelText(label('onboarding.openapi'))).not.toBeInTheDocument()
  expect(fetch).toHaveBeenCalledOnce()
})

it('aborts an old prepare request on unmount and never adopts its late result', async () => {
  let resolve!: (value: Response) => void
  const original = server()
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/prepare?') ? new Promise<Response>(yes => { resolve = yes }) : original(input, init))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup(); const connected = vi.fn()
  const view = render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={connected} />)
  await user.type(await screen.findByLabelText(label('onboarding.openapi')), 'https://api.bank.example/openapi.json'); await user.selectOptions(screen.getByLabelText(label('onboarding.profile')), 'bank-profile')
  await user.click(screen.getByRole('button', { name: label('onboarding.preview') }))
  const signal = fetch.mock.calls.find(([path]) => String(path).includes('/prepare?'))![1]?.signal
  view.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => { resolve(response(importPreview())); await Promise.resolve() })
  expect(connected).not.toHaveBeenCalled(); expect(fetch.mock.calls.some(([path]) => String(path).includes('/confirm?'))).toBe(false)
})

function LanguageControls() {
  const { setLocale } = useI18n()
  return <>{(['en', 'es', 'uk', 'de', 'pt'] as const).map(locale => <button key={locale} onClick={() => setLocale(locale)}>switch-{locale}</button>)}</>
}
it('retains reviewed fields and modes across all five locale changes without new API requests', async () => {
  await Promise.all((['en', 'es', 'uk', 'de', 'pt'] as const).map(loadAppCatalog))
  const fetch = server(); const user = userEvent.setup()
  renderRaw(<I18nProvider initialLocale="uk"><LanguageControls /><IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} /></I18nProvider>)
  await prepare(user); await completeReviews(user)
  await user.click(within(modeGroup('Read balance')).getByRole('radio', { name: label('core.mode.auto') }))
  const requests = fetch.mock.calls.length
  const read = screen.getByRole('combobox', { name: label('onboarding.effect') + ' Read balance' })
  for (const locale of ['en', 'es', 'uk', 'de', 'pt']) {
    await user.click(screen.getByRole('button', { name: 'switch-' + locale }))
    await waitFor(() => expect(document.documentElement.lang).toBe(locale))
    expect(read).toHaveValue('read'); expect(fetch.mock.calls).toHaveLength(requests)
  }
  expect(document.querySelector('[data-operation-key="GET /accounts/{account_id}/balance"] input[value="auto"]')).toBeChecked()
})

it('localizes known server reason codes on language change while preserving the source draft and hiding raw detail', async () => {
  await Promise.all((['en', 'es', 'uk', 'de', 'pt'] as const).map(loadAppCatalog))
  const fetch = server({ prepareError: { code: 'address_blocked', detail: 'private upstream token-like value must not render', status: 422 } })
  const user = userEvent.setup()
  renderRaw(<I18nProvider initialLocale="uk"><LanguageControls /><IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} /></I18nProvider>)
  const input = await screen.findByLabelText(label('onboarding.openapi'))
  await user.type(input, 'https://api.bank.example/openapi.json'); await user.selectOptions(screen.getByLabelText(label('onboarding.profile')), 'bank-profile')
  await user.click(screen.getByRole('button', { name: label('onboarding.preview') }))
  await screen.findByRole('alert')
  const requests = fetch.mock.calls.length
  for (const locale of ['en', 'es', 'uk', 'de', 'pt'] as const) {
    await user.click(screen.getByRole('button', { name: 'switch-' + locale }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(translateMessage({ key: 'onboarding.error.address' }, locale)))
    expect(input).toHaveValue('https://api.bank.example/openapi.json'); expect(fetch.mock.calls).toHaveLength(requests)
  }
  expect(screen.queryByText('private upstream token-like value must not render')).not.toBeInTheDocument()
})

it('rejects malformed preview scope rather than offering unchecked permissions', async () => {
  const preview = importPreview(); preview.operations[0]!.scope = {} as ImportPreview['operations'][number]['scope']
  const fetch = server({ preview }); const user = userEvent.setup()
  render(<IntegrationImportWizard businessId={importBusiness} token="synthetic-operator" onCancel={vi.fn()} onConnected={vi.fn()} />)
  await user.type(await screen.findByLabelText(label('onboarding.openapi')), 'https://api.bank.example/openapi.json'); await user.selectOptions(screen.getByLabelText(label('onboarding.profile')), 'bank-profile'); await user.click(screen.getByRole('button', { name: label('onboarding.preview') }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Некоректна структура відповіді сервера.')
  expect(screen.queryByRole('button', { name: label('onboarding.connect') })).not.toBeInTheDocument()
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/confirm?'))).toBe(false)
})
