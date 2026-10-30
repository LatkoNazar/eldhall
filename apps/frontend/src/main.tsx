import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAnalytics } from '@eldhall/analytics'
import App from './App'
import './styles.css'

// Document-level initialization also remains single during StrictMode and HMR.
initAnalytics(import.meta.env, 'app')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
