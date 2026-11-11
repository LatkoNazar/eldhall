import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAnalytics } from '@eldhall/analytics'
import App from './App'
import { detectLocale, I18nProvider } from './i18n'
import { loadAppCatalog } from './locales'
import { restoreAccent } from './lib/accent'
import { consumeOperatorLink } from './lib/operator-link'
import './styles.css'

// Document-level initialization also remains single during StrictMode and HMR.
restoreAccent()
const initialOperatorLink = consumeOperatorLink()
let initialLocale = initialOperatorLink.error === 'unscrubbed' ? 'en' as const : detectLocale(window)
try { await loadAppCatalog(initialLocale) } catch { initialLocale = 'en' }
if (initialOperatorLink.error !== 'unscrubbed' && import.meta.env.MODE !== 'local-demo') initAnalytics(import.meta.env, 'app')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider initialLocale={initialLocale}><App initialOperatorLink={initialOperatorLink} /></I18nProvider>
  </StrictMode>,
)
