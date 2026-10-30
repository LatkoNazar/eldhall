import { acquisitionContext, appLink, initAnalytics } from '@eldhall/analytics'
import './styles.css'

const analytics = initAnalytics(import.meta.env, 'landing')
const href = appLink(import.meta.env.PUBLIC_APP_URL, acquisitionContext())

for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[data-app-link]')) {
  if (!href) {
    // A missing build configuration should never send visitors to a broken URL.
    anchor.removeAttribute('href')
    anchor.setAttribute('aria-disabled', 'true')
    anchor.textContent = 'Застосунок готується'
    continue
  }
  anchor.href = href
  anchor.addEventListener('click', () => {
    const location = anchor.dataset.appLink
    if (location === 'header' || location === 'hero' || location === 'footer') analytics.trackLandingCta(location)
  })
}

document.querySelector('[data-year]')!.textContent = String(new Date().getFullYear())
