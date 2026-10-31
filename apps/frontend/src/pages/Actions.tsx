import { useEffect, useRef, useState } from 'react'
import { Avatar, Badge, Empty, Icon, Metric, Notice } from '../components/ui'
import { dateTime, errorText, money, request, toolLabels } from '../lib/api'
import type { CaseDetail, Metrics, Proposal, ProposalStatus, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { ActionCard } from './Inbox'

type Phase = 'pending' | 'running' | 'history'
interface ActionRow { proposal: Proposal; detail: CaseDetail; stale: boolean }
const phaseLabels: Record<Phase, string> = { pending: 'Очікують', running: 'Виконуються', history: 'Історія' }
function phaseOf(status: ProposalStatus): Phase { return status === 'pending' || status === 'approved' ? 'pending' : status === 'executing' ? 'running' : 'history' }

function useActionRows(token: string, caseIds: string[]) {
  const key = caseIds.join(',')
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ rows: ActionRow[]; failed: number; error: string; checkedAt: string | null; caseKey: string | null }>({ rows: [], failed: 0, error: '', checkedAt: null, caseKey: null })
  useEffect(() => {
    const ids = key ? key.split(',') : []
    const controller = new AbortController()
    let active = true
    let timer = 0
    async function load() {
      let cursor = 0
      const loaded = new Map<string, CaseDetail>()
      const failed = new Set<string>()
      let error = ''
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (active && cursor < ids.length) {
          const id = ids[cursor++]!
          try { loaded.set(id, await request<CaseDetail>(`/cases/${encodeURIComponent(id)}`, token, { signal: controller.signal })) }
          catch (cause) { failed.add(id); error = errorText(cause) }
        }
      }))
      if (!active) return
      setState(previous => {
        const rows: ActionRow[] = []
        for (const id of ids) {
          const detail = loaded.get(id)
          if (detail) rows.push(...detail.proposals.map(proposal => ({ proposal, detail, stale: false })))
          else rows.push(...previous.rows.filter(row => row.detail.case.id === id).map(row => ({ ...row, stale: true })))
        }
        rows.sort((left, right) => right.proposal.createdAt.localeCompare(left.proposal.createdAt) || left.proposal.id.localeCompare(right.proposal.id))
        return { rows, failed: failed.size, error, checkedAt: new Date().toISOString(), caseKey: key }
      })
      timer = window.setTimeout(() => void load(), 5000)
    }
    void load()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [key, token, revision])
  return { ...state, loading: state.caseKey !== key, refresh: () => setRevision(value => value + 1) }
}

export function Actions({ token, cases, casesError, metrics, metricsError, search, onRefresh }: { token: string; cases: SupportCase[] | null; casesError: string; metrics: Metrics | null; metricsError: string; search: string; onRefresh: () => void }) {
  const [limit, setLimit] = useState(50)
  const [phase, setPhase] = useState<Phase>('pending')
  const [selectedId, setSelectedId] = useState<string | null>()
  const [mobileDetail, setMobileDetail] = useState(false)
  const tableRegion = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<string | null>(null)
  const resource = useActionRows(token, (cases ?? []).slice(0, limit).map(item => item.id).sort())
  const query = search.trim().toLocaleLowerCase('uk-UA')
  const matching = resource.rows.filter(row => `${row.detail.customer.name} ${row.proposal.id} ${row.detail.case.id} ${toolLabels[row.proposal.tool] ?? row.proposal.tool}`.toLocaleLowerCase('uk-UA').includes(query))
  const visible = matching.filter(row => phaseOf(row.proposal.status) === phase)
  const counts = { pending: matching.filter(row => phaseOf(row.proposal.status) === 'pending').length, running: matching.filter(row => phaseOf(row.proposal.status) === 'running').length, history: matching.filter(row => phaseOf(row.proposal.status) === 'history').length }
  const selected = selectedId === null ? undefined : resource.rows.find(row => row.proposal.id === selectedId) ?? (selectedId === undefined ? visible[0] : undefined)
  const loaded = cases !== null && !resource.loading
  const incomplete = (cases?.length ?? 0) > limit
  useEffect(() => {
    const actionId = restoreFocusRef.current
    if (actionId === null || mobileDetail) return
    restoreFocusRef.current = null
    const buttons = tableRegion.current?.querySelectorAll<HTMLButtonElement>('button[data-action-id]')
    const rowButton = buttons && Array.from(buttons).find(button => button.dataset.actionId === actionId)
    ;(rowButton ?? tableRegion.current)?.focus()
  }, [mobileDetail, selectedId])
  function refresh() { resource.refresh(); onRefresh() }
  function changePhase(next: Phase) { setPhase(next); setSelectedId(undefined); setMobileDetail(false) }
  function closeInspector() { restoreFocusRef.current = selected?.proposal.id ?? ''; setMobileDetail(false); setSelectedId(null) }
  return <div className={`actions-page-grid ${mobileDetail ? 'actions-mobile-open' : ''}`}>
    <div className="actions-main">
      <div className="page-heading"><div><h1>Дії AI</h1><p>Перевіряйте пропозиції та контролюйте кожен крок виконання.</p></div><button onClick={refresh}><Icon name="refresh" />Оновити</button></div>
      <div className="metrics-grid compact-metrics actions-metrics">
        <Metric icon="clock" label="Очікують рішення / виконання" value={metrics ? (metrics.proposals.pending ?? 0) + (metrics.proposals.approved ?? 0) : '—'} />
        <Metric icon="spark" label="Виконуються" value={metrics?.proposals.executing ?? '—'} />
        <Metric icon="check" label="Виконано за весь час" value={metrics?.proposals.executed ?? '—'} />
        <Metric icon="help" label="Помилки / невідомий результат" value={metrics ? (metrics.proposals.failed ?? 0) + (metrics.proposals.unknown ?? 0) : '—'} />
      </div>
      <p className="actions-scope-caption muted">Показники — для всього сховища. У таблиці — фактично завантажені дії.</p>
      {casesError && <Notice error>{casesError} Список може бути застарілим. <button onClick={refresh}>Оновити дані</button></Notice>}
      {metricsError && <Notice error>Показники можуть бути застарілими. {metricsError}</Notice>}
      {resource.failed > 0 && <Notice error>Не вдалося оновити {resource.failed} звернень. Частина дій може бути відсутня або застаріла. {resource.error} <button onClick={refresh}>Повторити читання</button></Notice>}
      <section className="card actions-table-card" ref={tableRegion} tabIndex={-1} aria-label="Список дій AI">
        <div className="tabs actions-tabs" aria-label="Фази дій AI">{(['pending', 'running', 'history'] as const).map(value => <button key={value} className={phase === value ? 'active' : ''} aria-pressed={phase === value} onClick={() => changePhase(value)}>{phaseLabels[value]} <span>{loaded ? counts[value] : '—'}</span></button>)}</div>
        {visible.length ? <div className="table-scroll"><table className="actions-table"><caption className="sr-only">Дії AI: {phaseLabels[phase]}. Кожен рядок — окрема пропозиція.</caption><thead><tr><th scope="col">Клієнт</th><th scope="col">Запропонована дія</th><th scope="col">Сума</th><th scope="col">Статус</th><th scope="col">Час</th></tr></thead><tbody>{visible.map(row => <tr key={row.proposal.id} className={row.proposal.id === selected?.proposal.id ? 'selected-row' : ''}>
          <td><button className="action-row-select" data-action-id={row.proposal.id} aria-label={`Відкрити дію ${toolLabels[row.proposal.tool] ?? row.proposal.tool} для ${row.detail.customer.name}, ${row.proposal.id}`} aria-pressed={row.proposal.id === selected?.proposal.id} onClick={() => { setSelectedId(row.proposal.id); setMobileDetail(true) }}><Avatar name={row.detail.customer.name} /><span><strong>{row.detail.customer.name}</strong><small>#{row.proposal.id.slice(0, 8)}</small></span></button></td>
          <td><strong>{toolLabels[row.proposal.tool] ?? row.proposal.tool}</strong><small>{row.proposal.risk === 'high' ? 'Високий ризик' : 'Низький ризик'}{row.stale ? ' · застарілі дані' : ''}</small></td>
          <td className="action-table-amount">{proposalAmount(row.proposal, row.detail)}</td><td><Badge value={row.proposal.status} /></td><td><time dateTime={row.proposal.createdAt} title={`${dateTime(row.proposal.createdAt)} (Київ)`}>{dateTime(row.proposal.createdAt)}</time></td>
        </tr>)}</tbody></table></div> : <Empty icon="spark" title={!loaded ? 'Завантажуємо дії…' : resource.failed ? 'Частину дій не вдалося завантажити' : query ? 'Дій за цим запитом не знайдено' : phase === 'pending' ? 'Немає дій, що очікують рішення' : phase === 'running' ? 'Зараз жодна дія не виконується' : 'Історія дій поки порожня'}>{loaded && !query && !resource.failed ? 'Звернення без запропонованих дій до цього списку не потрапляють.' : 'Змініть пошук або оновіть дані.'}</Empty>}
        <div className="actions-table-footer"><span>{loaded ? `${visible.length} дій у цій вкладці` : 'Очікуємо дані'}{resource.checkedAt && ` · Оновлено ${dateTime(resource.checkedAt)}`}</span>{incomplete && <button onClick={() => setLimit(previous => previous + 50)}>Завантажити ще звернення</button>}</div>
      </section>
      {incomplete && <Notice>Завантажено дії з {Math.min(limit, cases?.length ?? 0)} із {cases?.length ?? 0} звернень. Лічильники вкладок охоплюють лише цю частину.</Notice>}
    </div>
    {selected ? <ActionInspector key={selected.proposal.id} row={selected} token={token} stale={!!casesError || resource.loading} onChanged={() => { setSelectedId(selected.proposal.id); refresh() }} onClose={closeInspector} onShowPhase={next => { setPhase(next); setSelectedId(selected.proposal.id) }} phase={phase} /> : <aside className="card actions-inspector-empty"><Empty icon="spark" title="Оберіть дію">Аргументи, перевірки політики та журнал з’являться праворуч.</Empty></aside>}
  </div>
}

function ActionInspector({ row, token, stale, onChanged, onClose, onShowPhase, phase }: { row: ActionRow; token: string; stale: boolean; onChanged: () => void; onClose: () => void; onShowPhase: (phase: Phase) => void; phase: Phase }) {
  const resource = useResource<CaseDetail>(`/cases/${encodeURIComponent(row.detail.case.id)}`, token, 2500)
  const detail = resource.data ?? row.detail
  const proposal = detail.proposals.find(item => item.id === row.proposal.id)
  const events = detail.audit.filter(event => event.data.proposalId === row.proposal.id).slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return <aside className="card actions-inspector" aria-label="Деталі обраної дії">
    <div className="actions-inspector-header"><div className="customer-heading"><Avatar name={detail.customer.name} /><div><h2>{detail.customer.name}</h2><span className="muted small">{detail.customer.email}</span><small>Дія #{row.proposal.id.slice(0, 8)}</small></div></div><button className="icon-button" aria-label="Закрити деталі дії" onClick={onClose}><Icon name="close" /></button></div>
    <div className="actions-inspector-label">Деталі дії</div>
    <div className="actions-inspector-body">
      {resource.error && <Notice error>Дані можуть бути застарілими. {resource.error}<button onClick={resource.refresh}>Оновити</button></Notice>}
      {proposal ? <>
        {phaseOf(proposal.status) !== phase && <Notice>Дія перейшла у вкладку «{phaseLabels[phaseOf(proposal.status)]}». <button onClick={() => onShowPhase(phaseOf(proposal.status))}>Перейти до вкладки</button></Notice>}
        <div className={`action-policy-summary ${proposal.policy.allowed ? '' : 'action-policy-denied'}`}><Icon name={proposal.policy.allowed ? 'check' : 'lock'} /><div><strong>{proposal.policy.allowed ? 'Дію дозволено політикою' : 'Політика не дозволила дію'}</strong><p>{proposal.policy.requiresApproval ? 'Погодження людини та виконання — окремі кроки.' : 'Політика не вимагає погодження для цієї дії.'}</p></div></div>
        <ActionCard compact proposal={proposal} detail={detail} token={token} stale={stale || row.stale || !!resource.error || resource.loading} onChanged={() => { resource.refresh(); onChanged() }} />
        <p className="actions-policy-source"><Icon name="lock" size={16} /><span>Джерело дозволу — серверна політика. Актуальні правила перевіряються повторно перед виконанням.</span></p>
        {proposal.tool === 'refund_payment' && <p className="actions-simulation"><Badge value="draft">Симуляція платежів</Badge><span>Реальні кошти не переміщуються.</span></p>}
        {proposal.decidedBy && <dl className="facts"><dt>Рішення</dt><dd>{proposal.decidedBy}</dd>{proposal.decidedAt && <><dt>Час рішення</dt><dd>{dateTime(proposal.decidedAt)}</dd></>}</dl>}
      </> : <Notice error>Ця дія більше не доступна. Оновіть список, щоб перевірити стан.</Notice>}
      <section className="actions-timeline"><h3>Журнал дії</h3>{events.length ? <ol className="timeline">{events.map(event => <li key={event.id}><strong>{actionEventLabel(event.type)}</strong><small>{event.actor} · {dateTime(event.createdAt)}</small>{typeof event.data.reason === 'string' && <p>{event.data.reason}</p>}</li>)}</ol> : <p className="muted small">Для цієї дії ще немає доступних подій у журналі.</p>}</section>
      <a className="actions-case-link" href="/operator">Відкрити вхідні звернення <Icon name="arrow" size={16} /></a>
    </div>
  </aside>
}

function proposalAmount(proposal: Proposal, detail: CaseDetail) {
  if (typeof proposal.args.amount_cents !== 'number') return '—'
  const payment = detail.payments.find(item => item.id === proposal.args.payment_id)
  return payment ? money(proposal.args.amount_cents, payment.currency) : `${proposal.args.amount_cents} мін. од.`
}
function actionEventLabel(type: string) { return ({ 'action.proposed': 'Дію запропоновано', 'action.denied': 'Дію не дозволено', 'action.approved': 'Дію погоджено', 'action.rejected': 'Погодження відхилено', 'action.executed': 'Дію виконано', 'action.failed': 'Виконання потребує уваги' } as Record<string, string>)[type] ?? type }
