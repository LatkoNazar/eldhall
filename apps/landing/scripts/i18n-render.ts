import { parse, serialize, defaultTreeAdapter as adapter, html, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { appLink } from '../../../packages/analytics/src/index.ts'
import { withLocale, type Locale } from '../../../packages/i18n/src/core.ts'
import { isMessageKey, loadLocale, translate, translatedAttributes } from '../src/i18n/index.ts'
import { scenarioView, type ViewNode } from '../src/scenario-view.ts'
import { landingOrigin, landingPageUrl, landingStructuredData } from '../src/structured-data.ts'

type Parent = Tree.Document | Tree.DocumentFragment | Tree.Element
function elements(root: Parent): Tree.Element[] {
  return root.childNodes.flatMap(node => 'tagName' in node ? [node, ...elements(node)] : [])
}
const attr = (node: Tree.Element, name: string) => node.attrs.find(item => item.name === name)?.value
function setAttr(node: Tree.Element, name: string, value: string) {
  const existing = node.attrs.find(item => item.name === name)
  if (existing) existing.value = value
  else node.attrs.push({ name, value })
}
function text(node: Tree.Element, value: string) {
  node.childNodes = []
  adapter.insertText(node, value)
}
function viewNode(spec: ViewNode, svg = false): Tree.ChildNode {
  if (typeof spec === 'string') return { nodeName: '#text', value: spec, parentNode: null }
  const inSvg = svg || spec.tag === 'svg'
  const node = adapter.createElement(spec.tag, inSvg ? html.NS.SVG : html.NS.HTML,
    Object.entries(spec.attrs ?? {}).map(([name, value]) => ({ name, value })))
  for (const child of spec.children) adapter.appendChild(node, viewNode(child, inSvg))
  return node
}

/** Messages are text, not HTML; only authored bindings and allowlisted attributes are translated. */
export async function renderLanding(source: string, locale: Locale, configuredAppUrl?: string, configuredLandingUrl?: string): Promise<string> {
  await loadLocale(locale)
  const document = parse(source)
  const nodes = elements(document)
  const byData = (name: string) => nodes.find(node => attr(node, name) !== undefined)
  const htmlNode = nodes.find(node => node.tagName === 'html')!
  setAttr(htmlNode, 'lang', locale)
  for (const node of nodes) {
    const key = attr(node, 'data-i18n')
    if (key !== undefined) {
      if (!isMessageKey(key)) throw new Error('Unknown landing text binding')
      text(node, translate(locale, key))
    }
    for (const name of translatedAttributes) {
      const attributeKey = attr(node, `data-i18n-${name}`)
      if (attributeKey === undefined) continue
      if (!isMessageKey(attributeKey)) throw new Error('Unknown landing attribute binding')
      setAttr(node, name, translate(locale, attributeKey))
    }
    if (node.tagName === 'option') {
      node.attrs = node.attrs.filter(item => item.name !== 'selected')
      if (attr(node, 'value') === locale) setAttr(node, 'selected', '')
    }
  }
  // A safe configured app URL is established before adding the UI language.
  const safeAppUrl = appLink(configuredAppUrl, {})
  const target = safeAppUrl ? withLocale(safeAppUrl, locale, 'https://landing.invalid') : null
  for (const node of nodes.filter(node => attr(node, 'data-app-link') !== undefined)) setAttr(node, 'href', target ?? '#scenario')
  for (const node of nodes.filter(node => attr(node, 'data-app-label') !== undefined)) text(node, translate(locale, target ? 'cta.open' : 'cta.fallback'))
  const view = scenarioView(locale)
  for (const [selector, value] of Object.entries({
    'data-scenario-business': view.business, 'data-scenario-kicker': view.kicker,
    'data-scenario-title': view.title, 'data-scenario-text': view.text, 'data-scenario-next': view.next,
  })) {
    const node = byData(selector)
    if (node) text(node, value)
  }
  for (const [selector, children] of [
    ['data-scenario-progress', view.progress], ['data-scenario-chat', view.chat], ['data-scenario-detail', view.details],
  ] as const) {
    const node = byData(selector)
    if (node) { node.childNodes = []; for (const child of children) adapter.appendChild(node, viewNode(child)) }
  }
  const previous = byData('data-scenario-prev')
  if (previous) setAttr(previous, 'disabled', '')
  const origin = landingOrigin(configuredLandingUrl)
  if (origin) {
    const head = nodes.find(node => node.tagName === 'head')!
    const siteUrl = landingPageUrl(origin, 'en')
    const pageUrl = landingPageUrl(origin, locale)
    const canonical = nodes.find(node => node.tagName === 'link' && attr(node, 'rel') === 'canonical')
      ?? adapter.createElement('link', html.NS.HTML, [{ name: 'rel', value: 'canonical' }])
    setAttr(canonical, 'href', pageUrl)
    if (!canonical.parentNode) adapter.appendChild(head, canonical)

    const schema = byData('data-landing-schema') ?? adapter.createElement('script', html.NS.HTML, [
      { name: 'type', value: 'application/ld+json' },
      { name: 'data-landing-schema', value: '' },
    ])
    setAttr(schema, 'data-site-url', siteUrl)
    setAttr(schema, 'data-page-url', pageUrl)
    text(schema, landingStructuredData(siteUrl, pageUrl, locale, translate(locale, 'meta.title'), translate(locale, 'hero.lead')))
    if (!schema.parentNode) adapter.appendChild(head, schema)
  }
  return serialize(document)
}
