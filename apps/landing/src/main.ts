import { acquisitionContext, appLink, initAnalytics } from '@eldhall/analytics'
import { withLocale, type Locale } from '../../../packages/i18n/src/core.ts'
import { translate } from './i18n/index.ts'
import { initLandingLanguage } from './language.ts'
import { initScenario, type ScenarioController } from './scenario.ts'
import { initUi } from './ui.ts'
import './styles.css'

const analytics = initAnalytics(import.meta.env, 'landing')
const safeAppUrl = appLink(import.meta.env.PUBLIC_APP_URL, acquisitionContext())
const anchors = [...document.querySelectorAll<HTMLAnchorElement>('[data-app-link]')]
const listeners = anchors.map(anchor => {
  const listener = () => {
    if (!safeAppUrl) return
    const location = anchor.dataset.appLink
    if (location === 'header' || location === 'hero' || location === 'footer') analytics.trackLandingCta(location)
  }
  anchor.addEventListener('click', listener)
  return () => anchor.removeEventListener('click', listener)
})
const updateLinks = (locale: Locale) => {
  const target = safeAppUrl ? withLocale(safeAppUrl, locale, window.location.href) : null
  anchors.forEach(anchor => {
    anchor.href = target ?? '#scenario'
    const label = anchor.querySelector('[data-app-label]')
    if (label) label.textContent = translate(locale, target ? 'cta.open' : 'cta.fallback')
  })
}
const year = document.querySelector('[data-year]')
if (year) year.textContent = String(new Date().getFullYear())
const disposeUi = initUi()
let scenario: ScenarioController | undefined
const language = initLandingLanguage(document, window, locale => {
  updateLinks(locale)
  if (scenario) scenario.setLocale(locale)
  else scenario = initScenario(document, (event, id) => analytics.track(event, { scenario: id }), locale)
})
import.meta.hot?.dispose(() => {
  language.destroy()
  scenario?.destroy()
  disposeUi()
  listeners.forEach(remove => remove())
})
