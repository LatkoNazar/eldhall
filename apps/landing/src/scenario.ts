import { localeCodes, type Locale } from '../../../packages/i18n/src/core.ts'
import type { ScenarioId } from './scenario-data.ts'
import { createViewNode, scenarioView } from './scenario-view.ts'

export type ScenarioEvent = (event: 'demo_started' | 'demo_completed', scenario: ScenarioId) => void
export interface ScenarioController { setLocale(locale: Locale): void; destroy(): void }

/** One controller owns the interaction; changing copy never installs more handlers. */
export function initScenario(root: ParentNode = document, onEvent: ScenarioEvent = () => {}, initialLocale: Locale = 'en'): ScenarioController | undefined {
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
  let locale = initialLocale
  let id: ScenarioId = 'refund'
  let index = 0
  let destroyed = false
  const seen = new Set<string>()
  const cleanup: Array<() => void> = []
  let cleanProgress = () => {}
  const listen = (target: HTMLElement, type: string, handler: EventListener) => {
    target.addEventListener(type, handler)
    cleanup.push(() => target.removeEventListener(type, handler))
  }
  const report = (event: 'demo_started' | 'demo_completed') => {
    const key = `${event}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    try { onEvent(event, id) } catch { /* Telemetry never controls the illustration. */ }
  }
  const render = (animate: boolean) => {
    const active = section.ownerDocument.activeElement
    const focusedStep = active && progress.contains(active) ? active.getAttribute('data-scenario-step') : null
    cleanProgress()
    const view = scenarioView(locale, id, index)
    const nodes = (items: Parameters<typeof createViewNode>[0][]) => items.map(item => createViewNode(item, section.ownerDocument))
    progress.replaceChildren(...nodes(view.progress))
    const progressButtons = [...progress.querySelectorAll<HTMLButtonElement>('[data-scenario-step]')]
    const handlers = progressButtons.map((button, i) => {
      const handler = () => { if (destroyed) return; index = i; render(true); progress.querySelectorAll<HTMLButtonElement>('button')[i]?.focus() }
      button.addEventListener('click', handler)
      return () => button.removeEventListener('click', handler)
    })
    cleanProgress = () => handlers.forEach(remove => remove())
    chat.replaceChildren(...nodes(view.chat))
    details.replaceChildren(...nodes(view.details))
    if (business) business.textContent = view.business
    kicker.textContent = view.kicker
    title.textContent = view.title
    text.textContent = view.text
    prev.disabled = view.previousDisabled
    next.textContent = view.next
    if (focusedStep !== null) progressButtons[Number(focusedStep)]?.focus()
    if (animate && kicker.parentElement) {
      kicker.parentElement.style.animation = 'none'
      void kicker.parentElement.offsetWidth
      kicker.parentElement.style.animation = ''
    }
    if (index > 0) report('demo_started')
    if (index === view.lastIndex) report('demo_completed')
  }
  const select = (tab: HTMLButtonElement, focus: boolean) => {
    if (destroyed || (tab.dataset.scenarioTab !== 'refund' && tab.dataset.scenarioTab !== 'limit')) return
    id = tab.dataset.scenarioTab
    index = 0
    for (const other of tabs) { const active = other === tab; other.setAttribute('aria-selected', String(active)); other.tabIndex = active ? 0 : -1 }
    panel.setAttribute('aria-labelledby', tab.id)
    if (focus) tab.focus()
    render(true)
  }
  tabs.forEach((tab, i) => {
    listen(tab, 'click', () => select(tab, false))
    listen(tab, 'keydown', event => {
      const key = (event as KeyboardEvent).key
      const offset = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
      if (!offset) return
      event.preventDefault()
      select(tabs[(i + offset + tabs.length) % tabs.length]!, true)
    })
  })
  listen(prev, 'click', () => {
    if (destroyed || index === 0) return
    index--; render(true)
    if (prev.disabled) next.focus()
  })
  listen(next, 'click', () => {
    if (destroyed) return
    index = index === scenarioView(locale, id, index).lastIndex ? 0 : index + 1
    render(true)
  })
  render(false)
  return {
    setLocale(value) { if (!destroyed && localeCodes.includes(value)) { locale = value; render(false) } },
    destroy() { destroyed = true; cleanProgress(); cleanup.forEach(remove => remove()) },
  }
}
