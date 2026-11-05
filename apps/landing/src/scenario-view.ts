import { formatNumber, type Locale } from '../../../packages/i18n/src/core.ts'
import { translate } from './i18n/index.ts'
import { getScenarios, type ScenarioId, type Step } from './scenario-data.ts'

export interface ViewElement { tag: string; attrs?: Record<string, string>; children: ViewNode[] }
export type ViewNode = string | ViewElement
const el = (tag: string, attrs: Record<string, string>, ...children: ViewNode[]): ViewElement => ({ tag, attrs, children })
const icon = (id: string) => el('svg', { class: 'i', 'aria-hidden': 'true' }, el('use', { href: `#${id}` }))

function details(step: Step, locale: Locale): ViewNode[] {
  const nodes: ViewNode[] = []
  if (step.tags?.length) nodes.push(el('div', { class: 'state-tags' }, ...step.tags.map(tag => el('span', { class: `tag tag-${tag.tone}` }, tag.label))))
  for (const check of step.checks ?? []) nodes.push(el('div', { class: `check-row ${check.passed ? 'pass' : 'fail'}` },
    icon(check.passed ? 'i-check' : 'i-x'), el('span', {},
      el('span', { class: 'visually-hidden' }, translate(locale, check.passed ? 'scenario.passed' : 'scenario.failed')),
      check.label, el('small', {}, check.detail))))
  if (step.facts?.length) nodes.push(el('dl', { class: 'kv' }, ...step.facts.flatMap(fact => [el('dt', {}, fact.term), el('dd', {}, fact.value)])))
  return nodes
}

/** One plain-text view model feeds both the browser and parse5 static renderer. */
export function scenarioView(locale: Locale, id: ScenarioId = 'refund', index = 0) {
  const scenario = getScenarios(locale)[id]
  const step = scenario.steps[index]!
  const progress = scenario.steps.map((item, i) => el('li', {}, el('button', {
    type: 'button', 'data-scenario-step': String(i),
    'aria-label': translate(locale, 'scenario.stepAria', { number: formatNumber(i + 1, locale), label: item.label }),
    ...(i === index ? { 'aria-current': 'step' } : {}), ...(i < index ? { class: 'is-done' } : {}),
  }, el('span', {}, item.label))))
  const chat = scenario.steps.slice(0, index + 1).flatMap(item => item.chat ?? []).map(message =>
    el('div', { class: `msg ${message.role === 'customer' ? 'msg-cust' : 'msg-ai'}` }, message.text))
  if (step.typing) chat.push(el('div', { class: 'msg-typing' },
    el('span', { class: 'visually-hidden' }, translate(locale, 'scenario.typing')), el('i', {}), el('i', {}), el('i', {})))
  return {
    business: scenario.business, progress, chat, details: details(step, locale),
    kicker: `${step.kicker} · ${translate(locale, 'scenario.illustration')}`, title: step.title, text: step.text,
    previousDisabled: index === 0, next: translate(locale, index === scenario.steps.length - 1 ? 'scenario.restart' : 'scenario.next'),
    lastIndex: scenario.steps.length - 1,
  }
}

export function createViewNode(spec: ViewNode, document: Document, svg = false): Node {
  if (typeof spec === 'string') return document.createTextNode(spec)
  const inSvg = svg || spec.tag === 'svg'
  const node = inSvg ? document.createElementNS('http://www.w3.org/2000/svg', spec.tag) : document.createElement(spec.tag)
  for (const [name, value] of Object.entries(spec.attrs ?? {})) node.setAttribute(name, value)
  for (const child of spec.children) node.appendChild(createViewNode(child, document, inSvg))
  return node
}
