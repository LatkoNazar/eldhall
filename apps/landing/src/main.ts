import { acquisitionContext, appLink, initAnalytics } from '@eldhall/analytics'
import { initScenario } from './scenario'
import { initUi } from './ui'
import './styles.css'

const analytics = initAnalytics(import.meta.env, 'landing')
// Single source for the MVP link: PUBLIC_APP_URL (build-time, see .env.example).
const href = appLink(import.meta.env.PUBLIC_APP_URL, acquisitionContext())

for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[data-app-link]')) {
  if (!href) {
    // Without a configured app URL, send visitors to the working walkthrough instead of a dead link.
    anchor.removeAttribute('aria-disabled')
    anchor.href = '#scenario'
    continue
  }
  anchor.href = href
  anchor.addEventListener('click', () => {
    const location = anchor.dataset.appLink
    if (location === 'header' || location === 'hero' || location === 'footer') analytics.trackLandingCta(location)
  })
}

const year = document.querySelector('[data-year]')
if (year) year.textContent = String(new Date().getFullYear())

initUi()
initScenario()
