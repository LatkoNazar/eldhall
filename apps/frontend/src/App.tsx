import { useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { CustomerChat } from './pages/CustomerChat'
import { Brand } from './components/ui'
import { readSession, saveSession } from './lib/api'

export default function App() {
  const [token, setToken] = useState(() => readSession('support.operator'))
  const [draft, setDraft] = useState('')
  if (window.location.pathname === '/chat') return <CustomerChat />
  if (token) return <Dashboard token={token} onLogout={() => { saveSession('support.operator', ''); setToken('') }} />
  return <main className="login-page">
    <div className="login-brand"><Brand /></div>
    <section className="login-card card" aria-labelledby="login-title">
      <span className="eyebrow">РОБОЧИЙ ПРОСТІР ПІДТРИМКИ</span>
      <h1 id="login-title">Клієнт почутий.<br />Рішення під контролем.</h1>
      <p className="muted">Діалоги, перевірені дії AI та команда — в одному просторі.</p>
      <form onSubmit={event => { event.preventDefault(); const value = draft.trim(); if (value) { saveSession('support.operator', value); setToken(value) } }}>
        <label htmlFor="operator-token">Ключ доступу оператора</label>
        <input id="operator-token" type="password" value={draft} onChange={event => setDraft(event.target.value)} autoComplete="off" required />
        <p className="field-hint">Ключ надає адміністратор. Він зберігається лише на час цієї вкладки.</p>
        <p className="field-hint">Для власного розгортання використовуйте OPERATOR_TOKEN із серверного .env. Це окремий ключ доступу до робочого простору; ключ Gemini або OpenRouter сюди не підходить.</p>
        <button className="primary full" type="submit">Відкрити робочий простір <span aria-hidden="true">→</span></button>
      </form>
      <a className="subtle-link" href="/chat">Відкрити клієнтський чат ↗</a>
    </section>
    <p className="login-footnote">AI пропонує. Людина погоджує. Сервер перевіряє та виконує.</p>
  </main>
}
