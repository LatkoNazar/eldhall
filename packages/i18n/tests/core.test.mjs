import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectLocale, formatDateTime, formatMoney, formatNumber, formatPercent, formatTime,
  localeCodes, localeStorageKey, normalizeLocale, rememberLocale, resolveLocale,
  updateLocaleUrl, withLocale,
} from '../src/core.ts'

test('supported browser language variants normalize to one of five locale codes', () => {
  for (const [input, expected] of [['EN-us', 'en'], ['es-MX', 'es'], ['uk-UA', 'uk'], ['de-DE', 'de'], ['pt-BR', 'pt']]) {
    assert.equal(normalizeLocale(input), expected)
  }
  for (const value of [undefined, null, 1111, 'fr', 'en_US', '<script>', '__proto__', 'x'.repeat(65)]) {
    assert.equal(normalizeLocale(value), undefined)
  }
  assert.equal(localeCodes.length, 5)
})

test('explicit links, static routes, saved choice and browser preferences have deterministic precedence', () => {
  const preferences = { url: 'https://app.example/operator?lang=es', routeLocale: 'pt', storedLocale: 'de', browserLanguages: ['fr-FR', 'uk-UA'] }
  assert.equal(resolveLocale(preferences), 'es')
  assert.equal(resolveLocale({ ...preferences, url: 'https://app.example/operator?lang=invalid' }), 'pt')
  assert.equal(resolveLocale({ ...preferences, url: 'https://app.example/operator?lang=es&lang=uk', routeLocale: undefined }), 'de')
  assert.equal(resolveLocale({ storedLocale: 'invalid', browserLanguages: ['fr-FR', 'uk-UA', 'en-US'] }), 'uk')
  assert.equal(resolveLocale({ browserLanguages: ['fr-FR'] }), 'en')
})

test('restricted storage is optional and persistence stores only a validated locale preference', () => {
  const writes = []
  const page = { location: { href: 'https://app.example/' }, navigator: { languages: ['de-DE'], language: 'en' }, localStorage: {
    getItem() { throw new Error('Storage blocked') },
    setItem(key, value) { writes.push([key, value]) },
  } }
  assert.equal(detectLocale(page), 'de')
  rememberLocale('pt', page)
  rememberLocale('untrusted', page)
  assert.deepEqual(writes, [[localeStorageKey, 'pt']])
  assert.doesNotThrow(() => rememberLocale('es', { ...page, localStorage: { setItem() { throw new Error('Full storage') } } }))
  assert.equal(detectLocale(), 'en')
})

test('locale links retain trusted destinations and attribution but reject unsafe schemes and URL credentials', () => {
  const href = withLocale('https://app.example/operator?utm_source=demo#case', 'es', 'https://landing.example/')
  const target = new URL(href)
  assert.equal(target.origin, 'https://app.example')
  assert.equal(target.pathname, '/operator')
  assert.equal(target.searchParams.get('utm_source'), 'demo')
  assert.equal(target.searchParams.get('lang'), 'es')
  assert.equal(target.hash, '#case')
  assert.equal(withLocale('/chat?customer=synthetic', 'uk', 'https://app.example/'), '/chat?customer=synthetic&lang=uk')
  assert.equal(withLocale('//other.example/chat', 'de', 'https://app.example/'), 'https://other.example/chat?lang=de')
  for (const input of ['javascript:alert(1)', 'data:text/html,x', 'https://user:private@app.example/']) assert.equal(withLocale(input, 'en', 'https://app.example/'), null)
  assert.equal(withLocale('/operator', 'invalid', 'https://app.example/'), null)
})

test('in-place preference updates preserve application routes, history state and fragments', () => {
  const calls = []
  const state = { navigationId: 7 }
  const page = { location: { href: 'https://app.example/operator?business=synthetic#details' }, history: { state, replaceState(...args) { calls.push(args) } } }
  updateLocaleUrl('de', page)
  assert.deepEqual(calls, [[state, '', '/operator?business=synthetic&lang=de#details']])
  updateLocaleUrl('pt', { ...page, location: { href: 'https://landing.example/es/?utm_source=demo#scenario' } }, true)
  assert.deepEqual(calls[1], [state, '', '/pt/?utm_source=demo&lang=pt#scenario'])
  assert.doesNotThrow(() => updateLocaleUrl('en', { ...page, history: { replaceState() { throw new Error('History blocked') } } }))
})

test('locale display conventions retain numeric values and currency minor units', () => {
  const normalized = value => value.replace(/[\u00a0\u202f]/g, ' ')
  const expected = { en: '1,234,567.89', es: '1.234.567,89', uk: '1 234 567,89', de: '1.234.567,89', pt: '1 234 567,89' }
  for (const locale of localeCodes) assert.equal(normalized(formatNumber(1234567.89, locale)), expected[locale])
  assert.equal(formatMoney(199, 'USD', 'en'), '$1.99')
  assert.equal(normalized(formatMoney(199, 'EUR', 'de')), '1,99 €')
  assert.equal(formatPercent(0.125, 'en', { maximumFractionDigits: 1 }), '12.5%')
  for (const invalid of [Number.NaN, Infinity, -Infinity]) assert.equal(formatMoney(invalid, 'USD', 'en'), '—')
})

test('translated date and time presentation preserves the Kyiv business timezone', () => {
  const instant = '2026-01-01T22:30:00Z'
  assert.match(formatDateTime(instant, 'en'), /1\/2\/26/)
  assert.match(formatDateTime(instant, 'de'), /02\.01\.26/)
  assert.equal(formatTime(instant, 'uk'), '00:30')
  assert.equal(formatDateTime('not-a-date', 'en'), '—')
})
