import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Avatar, Badge, Brand, Empty, Icon, Metric, Notice } from '../components/ui'
import { dateTime } from '../lib/api'
import type { Metrics, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { percent, supportKpis } from '../lib/support-metrics'
import { CaseWorkspace } from './Inbox'
import { Actions } from './Actions'
import { Insights } from './Insights'
import { Knowledge, Settings, Team } from './Resources'
import { AppLink } from '../components/AppLink'

const navigation = [
  { id: 'inbox', label: 'Вхідні', icon: 'inbox', href: '/operator' },
  { id: 'actions', label: 'Дії AI', icon: 'spark', href: '/operator/actions' },
  { id: 'analytics', label: 'Аналітика', icon: 'chart', href: '/operator/analytics' },
  { id: 'knowledge', label: 'База знань', icon: 'book', href: '/operator/knowledge' },
  { id: 'team', label: 'Команда', icon: 'team', href: '/operator/team' },
  { id: 'settings', label: 'Налаштування', icon: 'settings', href: '/operator/settings' },
]

export function Dashboard({ token, location, onLogout }: { token: string; location: string; onLogout: () => void }) {
  const url = new URL(location, window.location.origin)
  url.pathname = url.pathname.replace(/\/$/, '') || '/'
  const routeKey = url.pathname + url.search
  const page = navigation.find(item => item.href === url.pathname)?.id ?? 'inbox'
  const [searchState, setSearchState] = useState({ route: routeKey, value: '' })
  const search = searchState.route === routeKey ? searchState.value : ''
  const setSearch = (value: string) => setSearchState({ route: routeKey, value })
  const [menuOpen, setMenuOpen] = useState(false)
  const cases = useResource<SupportCase[]>('/cases', token, 4000)
  const metrics = useResource<Metrics>('/metrics', token, 5000)
  const title = navigation.find(item => item.id === page)?.label ?? 'Вхідні'
  const previousRoute = useRef(routeKey)
  useEffect(() => {
    if (previousRoute.current === routeKey) return
    previousRoute.current = routeKey
    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById('main-content')
      const target = main?.querySelector<HTMLElement>('h1') ?? main
      target?.setAttribute('tabindex', '-1')
      target?.focus({ preventScroll: true })
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [routeKey])
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Перейти до вмісту</a>
    <aside className="sidebar">
      <Brand />
      <button className="mobile-menu" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(value => !value)}>Меню <Icon name="inbox" /></button>
      <nav id="main-nav" className={menuOpen ? 'nav-open' : ''} aria-label="Головна навігація">
        {navigation.map(item => <AppLink href={item.href} key={item.id} onClick={() => setMenuOpen(false)} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'inbox' && metrics.data && <span className="nav-count">{metrics.data.cases - metrics.data.byStatus.resolved}</span>}</AppLink>)}
      </nav>
      <div className="sidebar-bottom"><a href="/chat" target="_blank" rel="noreferrer"><Icon name="help" /><span>Клієнтський чат ↗</span></a><div className="sidebar-caption">Підтримка з людським рішенням</div></div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        {page === 'inbox' || page === 'actions' ? <label className="search-field topbar-search"><Icon name="search" /><input aria-label={page === 'actions' ? 'Пошук дій за клієнтом або назвою' : 'Пошук звернень за ім’ям або темою'} placeholder={page === 'actions' ? 'Пошук клієнтів або дій…' : 'Пошук звернень, клієнтів або тем…'} value={search} onChange={event => setSearch(event.target.value)} /><kbd aria-hidden="true">⌕</kbd></label> : <span className="breadcrumb">Робочий простір <span>/</span> {title}</span>}
        <div className="operator-profile"><Avatar name="Оператор підтримки" /><span>Оператор<span className="profile-caption">Службовий доступ</span></span><button className="icon-button" aria-label="Вийти з робочого простору" onClick={onLogout}><Icon name="logout" /></button></div>
      </header>
      <main id="main-content" className="page">
        {page === 'inbox' && <Fragment key={routeKey}>
          <div className="page-heading"><div><h1>Вхідні звернення</h1><p>Кожна розмова — під увагою. Кожне рішення — вчасно.</p></div><button onClick={() => { cases.refresh(); metrics.refresh() }}><Icon name="refresh" />Оновити</button></div>
          {cases.error && <Notice error>{cases.error} {cases.checkedAt && `Останні підтверджені дані: ${dateTime(cases.checkedAt)} (Київ).`} <button className="text-button" onClick={cases.refresh}>Повторити читання</button></Notice>}
          {cases.loading ? <div className="card"><Empty title="Завантажуємо звернення…" /></div> : cases.data && <CaseWorkspace token={token} cases={cases.data} search={search} actionOnly={false} onChanged={() => { cases.refresh(); metrics.refresh() }} />}
        </Fragment>}
        {page === 'actions' && <Actions key={routeKey} token={token} cases={cases.data} casesError={cases.error} metrics={metrics.data} metricsError={metrics.error} search={search} onRefresh={() => { cases.refresh(); metrics.refresh() }} />}
        {page === 'analytics' && <AnalyticsWorkspace key={routeKey} token={token} />}
        {page === 'knowledge' && <Knowledge key={routeKey} token={token} />}
        {page === 'team' && <Team key={routeKey} token={token} />}
        {page === 'settings' && <Settings key={routeKey} token={token} />}
      </main>
    </div>
  </div>
}

function AnalyticsWorkspace({ token }: { token: string }) {
  const [view, setView] = useState(() => new URLSearchParams(window.location.search).get('view') === 'insights' ? 'insights' : 'metrics')
  const views = [{ id: 'metrics', label: 'Показники' }, { id: 'insights', label: 'Проблеми та KB' }]
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? (index + 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    const target = views[next]!
    setView(target.id)
    document.getElementById(`analytics-tab-${target.id}`)?.focus()
  }
  return <>
    <div className="tabs analytics-view-tabs" role="tablist" aria-label="Подання аналітики">{views.map((item, index) => <button id={`analytics-tab-${item.id}`} key={item.id} role="tab" aria-selected={view === item.id} aria-controls={`analytics-panel-${item.id}`} tabIndex={view === item.id ? 0 : -1} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)} onKeyDown={event => moveTab(event, index)}>{item.label}</button>)}</div>
    {views.map(item => <section key={item.id} id={`analytics-panel-${item.id}`} role="tabpanel" aria-labelledby={`analytics-tab-${item.id}`} hidden={view !== item.id}>{view === item.id && (item.id === 'insights' ? <Insights token={token} /> : <Analytics token={token} />)}</section>)}
  </>
}

function Analytics({ token }: { token: string }) {
  const data = useResource<Metrics>('/metrics', token, 8000)
  const metrics = data.data
  const statuses = ['open', 'awaiting_approval', 'escalated', 'resolved'] as const
  const proposalStates = ['pending', 'approved', 'executing', 'executed', 'failed', 'unknown', 'rejected', 'denied'] as const
  const totalProposals = metrics ? Object.values(metrics.proposals).reduce((sum, count) => sum + count, 0) : 0
  return <>
    <div className="page-heading"><div><h1>Аналітика підтримки</h1><p>Підтверджені показники поточного сховища звернень.</p></div><span className="period-label"><Icon name="clock" />Увесь доступний період</span></div>
    {data.error && <Notice error>{data.error} <button onClick={data.refresh}>Оновити</button></Notice>}
    <div className="metrics-grid">
      <Metric icon="check" label="Вирішені звернення" value={metrics?.byStatus.resolved ?? '—'} hint="Поточний статус звернення" />
      <Metric icon="clock" label="Середній час запуску AI" value={metrics?.avgAgentLatencyMs == null ? 'Немає даних' : `${(metrics.avgAgentLatencyMs / 1000).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} с`} hint="Середнє по всіх зафіксованих запусках" />
      <Metric icon="spark" label="Виконані дії" value={metrics?.proposals.executed ?? '—'} hint="Виконання, підтверджене сервером" />
      <Metric icon="team" label="Передані оператору" value={metrics?.byStatus.escalated ?? '—'} hint="Звернення з поточним статусом ескалації" />
    </div>
    {!metrics && data.loading && <section className="card padded" aria-busy="true"><h2>Якість підтримки</h2><p className="muted">Завантажуємо показники…</p></section>}
    {metrics && (() => { const k = supportKpis(metrics); return <section className="card padded" aria-labelledby="support-kpis"><h2 id="support-kpis">Якість підтримки</h2><p className="muted">Поточний стан сховища звернень{metrics.cases ? '' : ' — даних ще немає'}. Не історична аналітика: у demo-режимі дані скидаються після перезапуску.</p><div className="metrics-grid">
      <Metric icon="check" label="Рівень вирішення" value={percent(k.resolutionRate)} hint={`${k.resolved} з ${k.total} звернень`} />
      <Metric icon="team" label="Рівень ескалації" value={percent(k.escalationRate)} hint="Частка звернень, переданих оператору" />
      <Metric icon="spark" label="Успішні / невдалі дії" value={`${k.successfulActions} / ${k.failedActions}`} hint="За станом, підтвердженим сервером; повторні запити не рахуються" />
      <Metric icon="clock" label="Середній час вирішення" value="N/A" hint="Сервер ще не надає цей показник" />
    </div></section> })()}
    <div className="two-columns analytics-columns">
      <section className="card padded"><h2>Звернення за статусом</h2><p className="muted">Кількість звернень, одиниць</p>{metrics ? <><div className="bar-chart" aria-hidden="true">{statuses.map(status => <div className="bar-row" key={status}><Badge value={status} /><div className="bar-track"><div style={{ width: `${metrics.cases ? metrics.byStatus[status] / metrics.cases * 100 : 0}%` }} /></div><strong>{metrics.byStatus[status]}</strong></div>)}</div><table><caption className="sr-only">Кількість звернень за поточним статусом</caption><thead><tr><th>Статус</th><th>Звернень</th></tr></thead><tbody>{statuses.map(status => <tr key={status}><td><Badge value={status} /></td><td>{metrics.byStatus[status]}</td></tr>)}</tbody></table></> : <Empty icon="chart" title={data.loading ? 'Завантажуємо показники…' : 'Немає даних'} />}</section>
      <section className="card padded"><h2>Результати дій AI</h2><p className="muted">Погодження та виконання обліковуються окремо.</p>{metrics && totalProposals ? <table><caption className="sr-only">Усі дії за поточним станом</caption><thead><tr><th>Стан</th><th>Дій</th></tr></thead><tbody>{proposalStates.map(status => <tr key={status}><td><Badge value={status} /></td><td>{metrics.proposals[status] ?? 0}</td></tr>)}</tbody></table> : <Empty icon="spark" title="Ще немає зафіксованих дій" />}</section>
    </div>
    <section className="card padded analytics-footer"><div><h2>Якість виконання</h2><p>Запусків AI: <strong>{metrics?.agentRuns ?? '—'}</strong> · Резервні правила: <strong>{metrics?.fallbackRuns ?? '—'}</strong></p><p className="muted">Часовий пояс — Київ. Історичні тренди та порівняння періодів ще не збираються.</p></div><small className="muted">{data.checkedAt ? `Оновлено ${dateTime(data.checkedAt)}` : 'Очікуємо дані'}</small></section>
  </>
}
