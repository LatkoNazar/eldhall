import { useI18n, formatNumber, formatPercent } from '../i18n'
import { ReadOnlyDemoBanner } from '../components/ReadOnlyDemoBanner'
import { LanguagePicker } from '../components/LanguagePicker'
import { ErrorNotice } from '../components/ErrorNotice'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Avatar, Badge, Brand, Empty, Icon, Metric, Notice } from '../components/ui'
import { dateTime } from '../lib/api'
import type { Metrics, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { supportKpis } from '../lib/support-metrics'
import { CaseWorkspace } from './Inbox'
import { Actions } from './Actions'
import { Insights } from './Insights'
import { Integrations } from './Integrations'
import { Knowledge, Settings, Team } from './Resources'
import { AppLink } from '../components/AppLink'
import { WorkspaceProvider, type WorkspaceBusiness } from '../components/WorkspaceProvider'

const navigation = [
  { id: 'inbox', label: 'core.nav.inbox', icon: 'inbox', href: '/operator' },
  { id: 'actions', label: 'core.nav.actions', icon: 'spark', href: '/operator/actions' },
  { id: 'analytics', label: 'core.nav.analytics', icon: 'chart', href: '/operator/analytics' },
  { id: 'knowledge', label: 'core.nav.knowledge', icon: 'book', href: '/operator/knowledge' },
  { id: 'integrations', label: 'core.nav.integrations', icon: 'settings', href: '/operator/integrations' },
  { id: 'team', label: 'core.nav.team', icon: 'team', href: '/operator/team' },
  { id: 'settings', label: 'core.nav.settings', icon: 'settings', href: '/operator/settings' },
] as const

export function Dashboard({ token, location, onLogout }: { token: string; location: string; onLogout: () => void }) {
  return <WorkspaceProvider token={token}>{business => <WorkspaceDashboard token={token} location={location} onLogout={onLogout} business={business} />}</WorkspaceProvider>
}

function WorkspaceDashboard({ token, location, onLogout, business }: { token: string; location: string; onLogout: () => void; business: WorkspaceBusiness }) {
  const { t, locale } = useI18n()
  const url = new URL(location, window.location.origin)
  url.searchParams.delete('lang')
  url.pathname = url.pathname.replace(/\/$/, '') || '/'
  const routeKey = url.pathname + url.search
  const page = navigation.find(item => item.href === url.pathname)?.id ?? 'inbox'
  const [searchState, setSearchState] = useState({ route: routeKey, value: '' })
  const search = searchState.route === routeKey ? searchState.value : ''
  const setSearch = (value: string) => setSearchState({ route: routeKey, value })
  const [menuOpen, setMenuOpen] = useState(false)
  const cases = useResource<SupportCase[]>('/cases', token, 4000)
  const metrics = useResource<Metrics>('/metrics', token, 5000)
  const businessNames = { [business.id]: business.name }
  const refreshInbox = () => { cases.refresh(); metrics.refresh() }
  const title = t(navigation.find(item => item.id === page)?.label ?? 'core.nav.inbox')
  const previousRoute = useRef(routeKey)
  useEffect(() => {
    if (previousRoute.current === routeKey) return
    previousRoute.current = routeKey
    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById('main-content')
      const target = main?.querySelector<HTMLElement>('h1') ?? main
      target?.setAttribute('tabindex', '-1')
      target?.focus({ preventScroll: true })
      main?.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [routeKey])
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t("core.nav.skip")}</a>
    <aside className="sidebar">
      <Brand />
      <p className="workspace-identity" title={business.name}>{business.name}</p>
      <button className="mobile-menu" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(value => !value)}>{t("core.nav.menu")} <Icon name="inbox" /></button>
      <nav id="main-nav" className={menuOpen ? 'nav-open' : ''} aria-label={t("core.nav.label")}>
          {navigation.map(item => <AppLink href={item.href} key={item.id} aria-label={t(item.label)} title={t(item.label)} onClick={() => setMenuOpen(false)} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{t(item.label)}</span>{item.id === 'inbox' && metrics.data && <span className="nav-count">{formatNumber(metrics.data.cases - metrics.data.byStatus.resolved, locale)}</span>}</AppLink>)}
      </nav>
      <div className="sidebar-bottom"><AppLink href="/chat" target="_blank" rel="noreferrer" aria-label={t("core.nav.testAgent")} title={t("core.nav.testAgent")}><Icon name="help" /><span>{t("core.nav.testAgent")}</span></AppLink><div className="sidebar-caption">{t("core.nav.caption")}</div></div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        {page === 'inbox' || page === 'actions' ? <label className="search-field topbar-search"><Icon name="search" /><input aria-label={page === 'actions' ? t("core.nav.actionsSearch") : t("core.nav.casesSearch")} placeholder={page === 'actions' ? t("core.nav.actionsPlaceholder") : t("core.nav.casesPlaceholder")} value={search} onChange={event => setSearch(event.target.value)} /><kbd aria-hidden="true">⌕</kbd></label> : <span className="breadcrumb">{t("core.nav.workspace")} <span>/</span> {title}</span>}
        <div className="operator-profile"><LanguagePicker /><Avatar name={t("core.nav.operator")} /><span>{t("core.thread.operator")}<span className="profile-caption">{t("core.nav.staffAccess")}</span></span><button className="icon-button" aria-label={t("core.nav.logout")} onClick={onLogout}><Icon name="logout" /></button></div>
      </header>
      <main id="main-content" className={`page ${page === 'inbox' ? 'page-workspace' : page === 'actions' ? 'page-actions' : ''}`} tabIndex={page === 'inbox' ? -1 : 0}>
        <ReadOnlyDemoBanner />
        {page === 'inbox' && <Fragment key={routeKey}>
          <h1 className="sr-only">{t("core.inbox.title")}</h1>
          {cases.error && <Notice error>{cases.error} {cases.checkedAt && t('core.common.lastConfirmed', { time: dateTime(cases.checkedAt, locale) })} <button className="text-button" onClick={cases.refresh}>{t("core.common.retryRead")}</button></Notice>}
          {!cases.data && <div className="case-toolbar"><button className="workspace-refresh" onClick={refreshInbox}><Icon name="refresh" />{t("core.common.refresh")}</button></div>}
          {cases.loading ? <div className="card"><Empty title={t("core.inbox.loading")} /></div> : cases.data && <CaseWorkspace token={token} businessNames={businessNames} cases={cases.data} search={search} actionOnly={false} onRefresh={refreshInbox} onChanged={refreshInbox} />}
        </Fragment>}
        {page === 'actions' && <Actions key={routeKey} token={token} businessNames={businessNames} cases={cases.data} casesError={cases.error} metrics={metrics.data} metricsError={metrics.error} search={search} onRefresh={() => { cases.refresh(); metrics.refresh() }} />}
        {page === 'analytics' && <AnalyticsWorkspace key={routeKey} token={token} />}
        {page === 'knowledge' && <Knowledge key={routeKey} token={token} />}
        {page === 'integrations' && <Integrations key={routeKey} token={token} />}
        {page === 'team' && <Team key={routeKey} token={token} />}
        {page === 'settings' && <Settings key={routeKey} token={token} />}
      </main>
    </div>
  </div>
}

function AnalyticsWorkspace({ token }: { token: string }) {
  const { t } = useI18n()
  const [view, setView] = useState(() => new URLSearchParams(window.location.search).get('view') === 'insights' ? 'insights' : 'metrics')
  const views = [{ id: 'metrics', label: t("core.analytics.metrics") }, { id: 'insights', label: t("core.analytics.insights") }]
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? (index + 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    const target = views[next]!
    setView(target.id)
    document.getElementById(`analytics-tab-${target.id}`)?.focus()
  }
  return <>
    <h1 className="sr-only">{t(view === 'metrics' ? "core.analytics.title" : "operations.insights.title")}</h1>
    <div className="page-toolbar">
      <div className="tabs analytics-view-tabs" role="tablist" aria-label={t("core.analytics.views")}>{views.map((item, index) => <button id={`analytics-tab-${item.id}`} key={item.id} role="tab" aria-selected={view === item.id} aria-controls={`analytics-panel-${item.id}`} tabIndex={view === item.id ? 0 : -1} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)} onKeyDown={event => moveTab(event, index)}>{item.label}</button>)}</div>
      {view === 'metrics' && <span className="period-label"><Icon name="clock" />{t("core.analytics.period")}</span>}
    </div>
    {views.map(item => <section key={item.id} id={`analytics-panel-${item.id}`} role="tabpanel" aria-labelledby={`analytics-tab-${item.id}`} hidden={view !== item.id}>{view === item.id && (item.id === 'insights' ? <Insights token={token} embedded /> : <Analytics token={token} />)}</section>)}
  </>
}

function Analytics({ token }: { token: string }) {
  const { t, locale } = useI18n()
  const data = useResource<Metrics>('/metrics', token, 8000)
  const metrics = data.data
  const statuses = ['open', 'awaiting_approval', 'escalated', 'resolved'] as const
  const proposalStates = ['pending', 'approved', 'executing', 'executed', 'failed', 'unknown', 'rejected', 'denied'] as const
  const totalProposals = metrics ? Object.values(metrics.proposals).reduce((sum, count) => sum + count, 0) : 0
  return <>
    {data.error && <ErrorNotice error={data.errorCause}><button onClick={data.refresh}>{t("core.common.refresh")}</button></ErrorNotice>}
    <div className="metrics-grid">
      <Metric icon="check" label={t("core.analytics.resolved")} value={metrics?.byStatus.resolved ?? '—'} hint={t("core.analytics.currentStatus")} />
      <Metric icon="clock" label={t("core.analytics.latency")} value={metrics?.avgAgentLatencyMs == null ? t("core.common.noData") : `${formatNumber(metrics.avgAgentLatencyMs / 1000, locale, { maximumFractionDigits: 2 })} ${t('core.common.seconds')}`} hint={t("core.analytics.latencyHint")} />
      <Metric icon="spark" label={t("core.analytics.executed")} value={metrics?.proposals.executed ?? '—'} hint={t("core.analytics.executedHint")} />
      <Metric icon="team" label={t("core.analytics.escalated")} value={metrics?.byStatus.escalated ?? '—'} hint={t("core.analytics.escalatedHint")} />
    </div>
    {!metrics && data.loading && <section className="card padded" aria-busy="true"><h2>{t("core.analytics.quality")}</h2><p className="muted">{t("core.analytics.loading")}</p></section>}
    {metrics && (() => { const k = supportKpis(metrics); return <section className="card padded" aria-labelledby="support-kpis"><h2 id="support-kpis">{t("core.analytics.quality")}</h2><p className="muted">{t("core.analytics.currentStore")}{metrics.cases ? '' : " " + t("core.analytics.emptyStore") + ""}{t("core.analytics.currentStoreHint")}</p><div className="metrics-grid">
      <Metric icon="check" label={t("core.analytics.resolutionRate")} value={k.resolutionRate === null ? t('core.common.unavailable') : formatPercent(k.resolutionRate, locale)} hint={t('core.analytics.resolvedOf', { resolved: k.resolved, total: k.total })} />
      <Metric icon="team" label={t("core.analytics.escalationRate")} value={k.escalationRate === null ? t('core.common.unavailable') : formatPercent(k.escalationRate, locale)} hint={t("core.analytics.escalationHint")} />
      <Metric icon="spark" label={t("core.analytics.successFailure")} value={`${formatNumber(k.successfulActions, locale)} / ${formatNumber(k.failedActions, locale)}`} hint={t("core.analytics.outcomesHint")} />
      <Metric icon="clock" label={t("core.analytics.unknown")} value={k.unknownActions} hint={t("core.analytics.unknownHint")} />
      <Metric icon="clock" label={t("core.analytics.resolutionTime")} value={t('core.common.unavailable')} hint={t("core.analytics.unavailableHint")} />
    </div></section> })()}
    <div className="two-columns analytics-columns">
      <section className="card padded"><h2>{t("core.analytics.casesStatus")}</h2><p className="muted">{t("core.analytics.caseUnits")}</p>{metrics ? <><div className="bar-chart" aria-hidden="true">{statuses.map(status => <div className="bar-row" key={status}><Badge value={status} /><div className="bar-track"><div style={{ width: `${metrics.cases ? metrics.byStatus[status] / metrics.cases * 100 : 0}%` }} /></div><strong>{formatNumber(metrics.byStatus[status], locale)}</strong></div>)}</div><table><caption className="sr-only">{t("core.analytics.casesCaption")}</caption><thead><tr><th>{t("core.common.status")}</th><th>{t("core.common.cases")}</th></tr></thead><tbody>{statuses.map(status => <tr key={status}><td><Badge value={status} /></td><td>{formatNumber(metrics.byStatus[status], locale)}</td></tr>)}</tbody></table></> : <Empty icon="chart" title={data.loading ? t("core.analytics.loading") : t("core.common.noData")} />}</section>
      <section className="card padded"><h2>{t("core.analytics.actionResults")}</h2><p className="muted">{t("core.analytics.separateSteps")}</p>{metrics && totalProposals ? <table><caption className="sr-only">{t("core.analytics.actionsCaption")}</caption><thead><tr><th>{t("core.common.state")}</th><th>{t("core.common.actions")}</th></tr></thead><tbody>{proposalStates.map(status => <tr key={status}><td><Badge value={status} /></td><td>{formatNumber(metrics.proposals[status] ?? 0, locale)}</td></tr>)}</tbody></table> : <Empty icon="spark" title={t("core.analytics.noActions")} />}</section>
    </div>
    <section className="card padded analytics-footer"><div><h2>{t("core.analytics.executionQuality")}</h2><p>{t("core.analytics.runsPrefix")} <strong>{metrics ? formatNumber(metrics.agentRuns, locale) : '—'}</strong>  {t("core.analytics.fallbackPrefix")} <strong>{metrics ? formatNumber(metrics.fallbackRuns, locale) : '—'}</strong></p><p className="muted">{t("core.analytics.timezoneHint")}</p></div><small className="muted">{data.checkedAt ? t('core.common.updated', { time: dateTime(data.checkedAt, locale) }) : t("core.common.awaitingData")}</small></section>
  </>
}
