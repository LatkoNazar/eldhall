import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAnalytics } from '@eldhall/analytics'
import App from './App'
import { consumeOperatorLink } from './lib/operator-link'
import './styles.css'

// Document-level initialization also remains single during StrictMode and HMR.
const initialOperatorLink = consumeOperatorLink()
if (initialOperatorLink.error !== 'unscrubbed' && import.meta.env.MODE !== 'local-demo') initAnalytics(import.meta.env, 'app')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialOperatorLink={initialOperatorLink} />
  </StrictMode>,
)
