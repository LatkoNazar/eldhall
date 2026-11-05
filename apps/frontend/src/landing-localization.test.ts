import { fireEvent, within } from '@testing-library/dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderLanding } from '../../landing/scripts/i18n-render.ts'
import { landingLocalization } from '../../landing/scripts/i18n-plugin.ts'
import { applyLandingLocale, loadLocale, translate } from '../../landing/src/i18n/index.ts'
import { messageKeys } from '../../landing/src/i18n/keys.ts'
import { initLandingLanguage } from '../../landing/src/language.ts'
import { initScenario } from '../../landing/src/scenario.ts'
import { createViewNode } from '../../landing/src/scenario-view.ts'
import { localeCodes, localeStorageKey, type Locale } from '../../../packages/i18n/src/core.ts'

const master = readFileSync(resolve(process.cwd(), '../landing/index.html'), 'utf8')

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/en/?utm_campaign=demo#scenario')
})
const parsed = (source: string) => new DOMParser().parseFromString(source, 'text/html')
async function page(locale: Locale = 'en') {
  const html = parsed(await renderLanding(master, locale, 'https://app.example/operator?utm_source=landing'))
  document.documentElement.innerHTML = html.documentElement.innerHTML
  document.documentElement.lang = locale
  return document.querySelector<HTMLSelectElement>('[data-language-picker]')!
}

it('maintains complete independently editable catalogs and matching interpolation variables', async () => {
  const english = await loadLocale('en')
  const variables = (value: string) => [...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort()
  for (const locale of localeCodes) {
    const catalog = await loadLocale(locale)
    expect(Object.keys(catalog).sort()).toEqual([...messageKeys].sort())
    for (const key of messageKeys) {
      expect(catalog[key].trim()).not.toBe('')
      expect(variables(catalog[key])).toEqual(variables(english[key]))
    }
  }
})

it('renders static copy, a11y metadata and the initial demo for every locale without JavaScript', async () => {
  for (const locale of localeCodes) {
    const html = parsed(await renderLanding(master, locale, 'https://app.example/operator?utm_source=landing'))
    expect(html.documentElement.lang).toBe(locale)
    expect(html.title).toBe(translate(locale, 'meta.title'))
    expect(html.querySelector('meta[name=description]')?.getAttribute('content')).toBe(translate(locale, 'meta.description'))
    for (const element of html.querySelectorAll('[data-i18n]')) {
      if (element.hasAttribute('data-app-label')) continue
      expect(element.textContent).toBe(translate(locale, element.getAttribute('data-i18n') as typeof messageKeys[number]))
    }
    expect(html.querySelectorAll('[data-scenario-progress] button')).toHaveLength(5)
    expect(html.querySelector('[data-scenario-chat]')?.textContent).toContain(translate(locale, 'refund.request.chat'))
    expect(html.querySelector('[data-scenario-title]')?.textContent).toBe(translate(locale, 'refund.request.title'))
    expect(html.querySelector('[data-scenario-prev]')?.hasAttribute('disabled')).toBe(true)
    expect(html.querySelector<HTMLSelectElement>('[data-language-picker]')?.value).toBe(locale)
    expect(html.querySelector('[data-i18n="screens.caption"]')?.textContent).toBe(translate(locale, 'screens.caption'))
    expect([...html.images].map(image => image.getAttribute('src'))).toEqual(['/screens/inbox.webp', '/screens/chat.webp', '/screens/approve-step.webp', '/screens/analytics.webp'])
    for (const image of html.images) expect(image.alt).toBe(translate(locale, image.getAttribute('data-i18n-alt') as typeof messageKeys[number]))
    for (const link of html.querySelectorAll<HTMLAnchorElement>('[data-app-link]')) {
      const url = new URL(link.href)
      expect(url.origin).toBe('https://app.example')
      expect(url.searchParams.get('lang')).toBe(locale)
      // Existing appLink strips configured query/fragment; only captured campaign data is propagated at runtime.
      expect(url.searchParams.has('utm_source')).toBe(false)
    }
  }
})

it('keeps an honest localized on-page CTA when no safe app URL is configured', async () => {
  for (const configured of [undefined, 'javascript:alert(1)', 'https://user:secret@app.example']) {
    const html = parsed(await renderLanding(master, 'es', configured))
    for (const link of html.querySelectorAll('[data-app-link]')) expect(link.getAttribute('href')).toBe('#scenario')
    for (const label of html.querySelectorAll('[data-app-label]')) expect(label.textContent).toBe(translate('es', 'cta.fallback'))
  }
})

it('retains authored SVG and rich headings while creating view text without an HTML sink', async () => {
  await page('de')
  const heading = document.querySelector('#hero-title')!
  const icons = document.querySelectorAll('svg use').length
  applyLandingLocale(document, 'pt')
  expect(heading.querySelector('em')).toHaveTextContent(translate('pt', 'hero.emphasis'))
  expect(document.querySelectorAll('svg use')).toHaveLength(icons)
  const node = createViewNode({ tag: 'p', children: ['<img src=x onerror="alert(1)">&'] }, document)
  expect(node.textContent).toBe('<img src=x onerror="alert(1)">&')
  expect((node as Element).querySelector('img')).toBeNull()
  const escaped = await renderLanding('<p data-i18n="check.over"></p>', 'en')
  expect(parsed(escaped).querySelector('p')?.textContent).toContain('>')
})

it('changes locale at the active scenario step without losing keyboard focus or inflating telemetry', async () => {
  await page()
  const track = vi.fn()
  const controller = initScenario(document, track)!
  fireEvent.click(document.querySelector('[data-scenario-tab="limit"]')!)
  fireEvent.click(document.querySelector('[data-scenario-step="3"]')!)
  for (const locale of localeCodes) {
    await loadLocale(locale)
    applyLandingLocale(document, locale)
    controller.setLocale(locale)
    expect(document.querySelector('[data-scenario-tab="limit"]')).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('[data-scenario-step="3"]')).toHaveAttribute('aria-current', 'step')
    expect(document.querySelector('[data-scenario-step="3"]')).toHaveFocus()
    expect(document.querySelector('[data-scenario-title]')).toHaveTextContent(translate(locale, 'limit.decision.title'))
  }
  fireEvent.click(document.querySelector('[data-scenario-next]')!)
  expect(document.querySelector('[data-scenario-step="4"]')).toHaveAttribute('aria-current', 'step')
  expect(track.mock.calls).toEqual([['demo_started', 'limit'], ['demo_completed', 'limit']])
  controller.destroy()
  fireEvent.click(document.querySelector('[data-scenario-next]')!)
  expect(document.querySelector('[data-scenario-step="4"]')).toHaveAttribute('aria-current', 'step')
})

it('ignores late chunks, preserves failures, allows retry and removes language handlers on disposal', async () => {
  const picker = await page()
  const pending = new Map<Locale, { resolve: () => void; reject: () => void }>()
  const load = vi.fn((locale: Locale) => locale === 'en' ? loadLocale(locale) : new Promise<void>((resolve, reject) => {
    pending.set(locale, { resolve: () => { void loadLocale(locale).then(() => resolve()) }, reject: () => reject(new Error('private backend details')) })
  }))
  const applied = vi.fn()
  const language = initLandingLanguage(document, window, applied, load)
  await language.ready
  const select = (locale: Locale) => fireEvent.change(picker, { target: { value: locale } })
  select('de'); select('es')
  pending.get('es')!.resolve()
  await vi.waitFor(() => expect(document.documentElement.lang).toBe('es'))
  pending.get('de')!.resolve()
  await Promise.resolve()
  expect(document.documentElement.lang).toBe('es')
  expect(localStorage.getItem(localeStorageKey)).toBe('es')
  expect(location.pathname).toBe('/es/')
  expect(location.search).toBe('?utm_campaign=demo&lang=es')
  expect(location.hash).toBe('#scenario')
  select('pt'); pending.get('pt')!.reject()
  await vi.waitFor(() => expect(document.querySelector('[data-language-status]')).toHaveTextContent(translate('es', 'languageError')))
  expect(picker.value).toBe('es')
  expect(localStorage.getItem(localeStorageKey)).toBe('es')
  expect(document.body).not.toHaveTextContent('private backend details')
  select('pt'); pending.get('pt')!.resolve()
  await vi.waitFor(() => expect(document.documentElement.lang).toBe('pt'))
  expect(applied.mock.calls.map(call => call[0])).toEqual(['en', 'es', 'pt'])
  language.destroy()
  select('uk')
  expect(load).toHaveBeenCalledTimes(5)
})

it('honors query before route preference and keeps a failed initial static page readable', async () => {
  await page('uk')
  history.replaceState(null, '', '/uk/?lang=de')
  const apply = vi.fn()
  const language = initLandingLanguage(document, window, apply)
  await language.ready
  expect(document.documentElement.lang).toBe('de')
  language.destroy()
  await page('uk')
  history.replaceState(null, '', '/uk/')
  const title = document.title
  const failing = initLandingLanguage(document, window, apply, () => Promise.reject(new Error('failed')))
  await failing.ready
  expect(document.title).toBe(title)
  expect(document.documentElement.lang).toBe('uk')
  expect(within(document.body).getByRole('combobox')).toHaveValue('uk')
  failing.destroy()
})

it('emits five directories from the same transformed asset document', async () => {
  const plugin = landingLocalization('https://app.example/operator')
  const emitFile = vi.fn()
  const bundle = { 'index.html': { type: 'asset', source: master.replace('/src/main.ts', '/assets/main-example.js') } }
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') throw new Error('Missing static locale build hook')
  await hook.call({ emitFile } as never, {} as never, bundle as never, false)
  expect(emitFile).toHaveBeenCalledTimes(5)
  for (const [index, locale] of localeCodes.entries()) {
    const asset = emitFile.mock.calls[index]![0]
    expect(asset.fileName).toBe(`${locale}/index.html`)
    expect(parsed(asset.source).documentElement.lang).toBe(locale)
    expect(asset.source).toContain('/assets/main-example.js')
    expect(asset.source).not.toContain('/src/main.ts')
  }
})
