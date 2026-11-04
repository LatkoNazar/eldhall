import { SCENARIOS, type Scenario, type Step } from './scenario-data'

const SVG = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function icon(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

function detail(step: Step): Node[] {
  const nodes: Node[] = []
  if (step.tags?.length) {
    const tags = el('div', 'state-tags')
    for (const tag of step.tags) tags.append(el('span', `tag tag-${tag.tone}`, tag.label))
    nodes.push(tags)
  }
  for (const check of step.checks ?? []) {
    const row = el('div', `check-row ${check.passed ? 'pass' : 'fail'}`)
    const body = el('span')
    body.append(el('span', 'visually-hidden', check.passed ? 'Пройдено: ' : 'Не пройдено: '), check.label, el('small', undefined, check.detail))
    row.append(icon(check.passed ? 'i-check' : 'i-x'), body)
    nodes.push(row)
  }
  if (step.facts?.length) {
    const list = el('dl', 'kv')
    for (const fact of step.facts) list.append(el('dt', undefined, fact.term), el('dd', undefined, fact.value))
    nodes.push(list)
  }
  return nodes
}

/** Wires the interactive walkthrough. Does nothing when the section is absent. */
export type ScenarioEvent = (event: 'demo_started' | 'demo_completed', scenario: 'refund' | 'limit') => void

export function initScenario(root: ParentNode = document, onEvent: ScenarioEvent = () => {}): void {
  const section = root.querySelector<HTMLElement>('[data-scenario]')
  if (!section) return
  const q = <T extends Element>(selector: string) => section.querySelector<T>(selector)
  const tabs = [...section.querySelectorAll<HTMLButtonElement>('[data-scenario-tab]')]
  const panel = q<HTMLElement>('[data-scenario-panel]')
  const progress = q<HTMLOListElement>('[data-scenario-progress]')
  const chat = q<HTMLElement>('[data-scenario-chat]')
  const business = q<HTMLElement>('[data-scenario-business]')
  const kicker = q<HTMLElement>('[data-scenario-kicker]')
  const title = q<HTMLElement>('[data-scenario-title]')
  const text = q<HTMLElement>('[data-scenario-text]')
  const details = q<HTMLElement>('[data-scenario-detail]')
  const prev = q<HTMLButtonElement>('[data-scenario-prev]')
  const next = q<HTMLButtonElement>('[data-scenario-next]')
  if (!panel || !progress || !chat || !kicker || !title || !text || !details || !prev || !next) return

  let scenario: Scenario = SCENARIOS.refund
  let index = 0
  const seen = new Set<string>()
  // Each scenario reports start/completion once per page view.
  const report = (event: 'demo_started' | 'demo_completed') => { const key = `${event}:${scenario.id}`; if (!seen.has(key)) { seen.add(key); try { onEvent(event, scenario.id as 'refund' | 'limit') } catch { /* The walkthrough remains usable without telemetry. */ } } }

  const render = (animateLive: boolean) => {
    const step = scenario.steps[index]!
    if (business) business.textContent = scenario.business

    progress.replaceChildren(...scenario.steps.map((item, i) => {
      const li = el('li')
      const button = el('button')
      button.type = 'button'
      button.append(el('span', undefined, item.label))
      button.setAttribute('aria-label', `Крок ${i + 1}: ${item.label}`)
      if (i === index) button.setAttribute('aria-current', 'step')
      if (i < index) button.classList.add('is-done')
      button.addEventListener('click', () => {
        index = i
        render(true)
        // The progress list is rebuilt on render; keep keyboard focus on the same step.
        progress.querySelectorAll('button')[i]?.focus()
      })
      li.append(button)
      return li
    }))

    const messages = scenario.steps.slice(0, index + 1).flatMap(item => item.chat ?? [])
    const bubbles: Node[] = messages.map(m => el('div', `msg ${m.role === 'customer' ? 'msg-cust' : 'msg-ai'}`, m.text))
    if (step.typing) {
      const typing = el('div', 'msg-typing')
      typing.append(el('span', 'visually-hidden', 'AI аналізує звернення'), el('i'), el('i'), el('i'))
      bubbles.push(typing)
    }
    chat.replaceChildren(...bubbles)

    kicker.textContent = `${step.kicker} · ілюстрація`
    title.textContent = step.title
    text.textContent = step.text
    details.replaceChildren(...detail(step))
    const live = kicker.parentElement
    if (animateLive && live) { live.style.animation = 'none'; void live.offsetWidth; live.style.animation = '' }

    prev.disabled = index === 0
    if (index > 0) report('demo_started')
    if (index === scenario.steps.length - 1) report('demo_completed')
    next.textContent = index === scenario.steps.length - 1 ? 'Спочатку' : 'Далі'
  }

  const select = (tab: HTMLButtonElement, focus: boolean) => {
    const id = tab.dataset.scenarioTab as keyof typeof SCENARIOS
    scenario = SCENARIOS[id]
    index = 0
    for (const other of tabs) {
      const active = other === tab
      other.setAttribute('aria-selected', String(active))
      other.tabIndex = active ? 0 : -1
    }
    panel.setAttribute('aria-labelledby', tab.id)
    if (focus) tab.focus()
    render(true)
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false))
    tab.addEventListener('keydown', event => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!offset) return
      event.preventDefault()
      select(tabs[(i + offset + tabs.length) % tabs.length]!, true)
    })
  })
  prev.addEventListener('click', () => {
    if (index === 0) return
    index--
    render(true)
    if (prev.disabled) next.focus()  // a disabled button would drop focus to <body>
  })
  next.addEventListener('click', () => { index = index === scenario.steps.length - 1 ? 0 : index + 1; render(true) })

  render(false)
}
