import { AppLink } from '../components/AppLink'
import { useEffect, useState } from 'react'
import { Avatar, Badge, Empty, Icon, Notice } from '../components/ui'
import { MessageThread } from '../components/MessageThread'
import { ClassificationSummary } from '../components/ClassificationSummary'
import { dateTime, errorText, intentLabels, money, request, toolLabels } from '../lib/api'
import type { CaseDetail, CaseStatus, Proposal, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { registerNavigationGuard } from '../lib/navigation'

export function CaseWorkspace({ token, cases, search, actionOnly, onChanged }: { token: string; cases: SupportCase[]; search: string; actionOnly: boolean; onChanged: () => void }) {
  const [linkedCase] = useState(() => new URLSearchParams(window.location.search).get('caseId') ?? '')
  const [selected, setSelected] = useState(linkedCase)
  const [status, setStatus] = useState<CaseStatus | ''>('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const filtered = cases.filter(item => (!status || item.status === status) && `${item.customerName} ${item.intent ? intentLabels[item.intent] : ''} ${item.analysis?.classification?.label ?? ''}`.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA')))
  const activeId = filtered.some(item => item.id === selected) || (!!linkedCase && selected === linkedCase && !status && !search) ? selected : filtered[0]?.id
  return <>
    <div className="tabs" aria-label="Фільтр звернень"><button className={!status ? 'active' : ''} onClick={() => setStatus('')}>Усі <span>{cases.length}</span></button>{(['open', 'awaiting_approval', 'escalated', 'resolved'] as const).map(value => <button className={status === value ? 'active' : ''} key={value} onClick={() => setStatus(value)}>{({ open: 'Відкриті', awaiting_approval: 'На погодженні', escalated: 'Оператору', resolved: 'Вирішені' })[value]} <span>{cases.filter(item => item.status === value).length}</span></button>)}</div>
    <div className={`inbox-layout ${actionOnly ? 'action-layout' : ''} ${mobileDetail ? 'mobile-detail-open' : ''}`}>
      <section className="case-list card" aria-label="Черга звернень"><div className="list-caption"><span>{actionOnly ? 'Звернення та їхні дії' : 'Усі канали'}</span><small>{filtered.length} звернень</small></div>{filtered.length ? filtered.map(item => <button className={`case-item ${item.id === activeId ? 'selected' : ''}`} key={item.id} onClick={() => { setSelected(item.id); setMobileDetail(true) }} aria-pressed={item.id === activeId}><Avatar name={item.customerName} seed={`${item.businessId}:${item.customerId}`} /><span className="case-item-body"><span className="case-item-heading"><strong>{item.customerName}</strong><small>{item.priority}</small></span><span className="case-subject">{item.intent ? intentLabels[item.intent] ?? item.intent : 'Нове звернення'}</span>{item.analysis?.classification && <span className="case-preview">Клас: {item.analysis.classification.label}</span>}<span className="case-preview">{item.analysis?.summary ?? 'Очікує першого повідомлення'}</span><span className="case-item-bottom"><Badge value={item.status} /><time dateTime={item.updatedAt} title={`${dateTime(item.updatedAt)} (Київ)`}>{new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(new Date(item.updatedAt))}</time></span></span></button>) : <Empty title={cases.length ? 'Нічого не знайдено' : 'Усе починається з розмови'}>{cases.length ? 'Змініть пошук або фільтр.' : <><AppLink href="/chat" target="_blank" rel="noreferrer">Відкрийте клієнтський чат</AppLink>, щоб створити перше звернення.</>}</Empty>}</section>
      {activeId ? <CaseView key={activeId} id={activeId} token={token} actionOnly={actionOnly} draft={drafts[activeId] ?? ''} onDraft={value => setDrafts(previous => ({ ...previous, [activeId]: value }))} onBack={() => setMobileDetail(false)} onChanged={onChanged} /> : <section className="card case-placeholder"><Empty icon="spark" title="Місце для наступного рішення">Діалог, дані клієнта та дозволені дії з’являться після вибору звернення.</Empty></section>}
    </div>
  </>
}

function CaseView({ id, token, actionOnly, draft, onDraft, onBack, onChanged }: { id: string; token: string; actionOnly: boolean; draft: string; onDraft: (draft: string) => void; onBack: () => void; onChanged: () => void }) {
  const resource = useResource<CaseDetail>(`/cases/${encodeURIComponent(id)}`, token, 3000)
  const setDraft = onDraft
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const detail = resource.data
  useEffect(() => {
    if (!draft) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const removeGuard = registerNavigationGuard(() => window.confirm('Є ненадіслана відповідь. Залишити її і продовжити?'))
    window.addEventListener('beforeunload', warn)
    return () => { removeGuard(); window.removeEventListener('beforeunload', warn) }
  }, [draft])
  async function caseAction(action: string, body?: unknown) {
    if (!detail || busy) return
    setBusy(action); setError(''); setNotice('')
    try {
      await request(`/cases/${id}/${action}`, token, { method: 'POST', body: { ownershipVersion: detail.case.ownershipVersion, ...typeof body === 'object' && body !== null ? body : {} } })
      if (action === 'messages') { setDraft(''); setNotice('Повідомлення надіслано клієнту.') }
      else setNotice(action === 'takeover' ? 'Діалог передано оператору. AI більше не відповідає автоматично.' : action === 'resume-bot' ? 'Діалог повернено AI.' : 'Звернення позначено вирішеним.')
      resource.refresh(); onChanged()
    } catch (cause) { setError(errorText(cause)); resource.refresh() }
    finally { setBusy('') }
  }
  if (!detail) return <section className="card"><Empty title={resource.loading ? 'Завантажуємо діалог…' : 'Діалог недоступний'} />{resource.error && <Notice error>{resource.error}<button onClick={resource.refresh}>Оновити</button></Notice>}</section>
  const analysis = detail.case.analysis
  return <>
    <section className={`conversation card ${actionOnly ? 'actions-conversation' : ''}`} aria-label={`Діалог з ${detail.customer.name}`}>
      <div className="conversation-header"><button className="mobile-back" onClick={onBack}>← До черги</button><div className="conversation-identity"><div className="customer-heading"><Avatar name={detail.customer.name} seed={`${detail.customer.businessId}:${detail.customer.id}`} /><div><h2>{detail.customer.name}</h2><span className="muted small">{detail.customer.email}</span></div></div><div className="case-controls">{detail.case.ownership !== 'staff' ? <button disabled={!!busy || !!resource.error} onClick={() => void caseAction('takeover')}><Icon name="team" size={17} />Взяти в роботу</button> : <button disabled={!!busy || !!resource.error} onClick={() => void caseAction('resume-bot')}><Icon name="spark" size={17} />Повернути AI</button>}{detail.case.status !== 'resolved' && <button disabled={!!busy || !!resource.error} onClick={() => void caseAction('resolve')}>Вирішено</button>}</div></div><div className="conversation-meta"><h3>{detail.case.intent ? intentLabels[detail.case.intent] : 'Нове звернення'}</h3><div className="case-tags"><Badge value={detail.case.status} /><Badge value={detail.case.ownership ?? 'bot'} /><Badge value={detail.case.priority} /></div></div></div>
      {resource.error && <Notice error>Дані можуть бути застарілими. {resource.error}</Notice>}
      {error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
      {actionOnly ? <div className="actions-detail-scroll"><h3>Запропоновані дії</h3>{detail.proposals.length ? detail.proposals.map(proposal => <ActionCard key={proposal.id} proposal={proposal} detail={detail} token={token} stale={!!resource.error} onChanged={() => { resource.refresh(); onChanged() }} />) : <Empty icon="spark" title="У цьому зверненні немає дій" />}</div> : <MessageThread messages={detail.messages} customerName={detail.customer.name} />}
      {!actionOnly && <form className="composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) void caseAction('messages', { body: draft.trim() }) }}><label htmlFor={`reply-${id}`}>Відповідь клієнту <span className="muted">· видима клієнту</span></label><textarea id={`reply-${id}`} rows={2} maxLength={2000} placeholder={detail.case.ownership === 'staff' ? 'Напишіть відповідь…' : 'Візьміть діалог у роботу, щоб відповісти'} disabled={detail.case.ownership !== 'staff' || !!busy || !!resource.error} value={draft} onChange={event => setDraft(event.target.value)} /><div className="composer-footer"><small className="muted">{draft ? 'Чернетка · ще не надіслано' : 'Людська увага, коли вона потрібна'}</small><button className="primary" type="submit" disabled={!draft.trim() || !!busy || detail.case.ownership !== 'staff' || !!resource.error}><Icon name="send" size={17} />{busy === 'messages' ? 'Надсилаємо…' : 'Надіслати'}</button></div></form>}
    </section>
    <aside className="inspector card" aria-label="AI-копілот і дані звернення"><h2><Icon name="spark" /> AI-копілот</h2>
      {analysis ? <section className="inspector-section"><h3>Коротко про звернення</h3><p>{analysis.summary}</p><div className="inline-meta"><Badge value={analysis.source} /><small>{analysis.model}</small></div><details><summary>Аналіз і сигнали</summary><p>{analysis.reasoning}</p><p>Настрій: {({ calm: 'спокійний', frustrated: 'розчарований', angry: 'розгніваний', abusive: 'образливий' } as Record<string, string>)[analysis.sentiment.label] ?? analysis.sentiment.label}</p><p className="muted small">Оцінка моделі, а не дозвіл на дію.</p><ul>{analysis.sentiment.signals.map((signal, index) => <li key={index}>{signal}</li>)}</ul></details></section> : <section className="inspector-section"><p className="muted">AI ще не аналізував це звернення.</p></section>}
      {analysis?.classification && <ClassificationSummary classification={analysis.classification} />}
      <section className="inspector-section"><h3><Icon name="team" size={18} /> Дані клієнта</h3><dl className="facts"><dt>Ім’я</dt><dd>{detail.customer.name}</dd><dt>План</dt><dd>{detail.customer.plan}</dd><dt>Керування</dt><dd>{detail.case.assignedTo ?? 'AI-помічник'}</dd></dl></section>
      <section className="inspector-section"><h3>Платежі клієнта</h3><p className="small muted">Платіжний провайдер — симуляція. Реальні гроші не рухаються.</p>{detail.payments.map(payment => <div className="payment-row" key={payment.id}><div><strong>{money(payment.amountCents, payment.currency)}</strong><small>{payment.description}</small><small>{dateTime(payment.createdAt)}</small></div><Badge value={payment.status} /></div>)}{!detail.payments.length && <p className="muted">Платежів немає.</p>}</section>
      {!actionOnly && detail.proposals.map(proposal => <ActionCard key={proposal.id} proposal={proposal} detail={detail} token={token} stale={!!resource.error} onChanged={() => { resource.refresh(); onChanged() }} />)}
      {detail.refunds.length > 0 && <section className="inspector-section"><h3>Підтверджені повернення</h3>{detail.refunds.map(refund => <p key={refund.id}><strong>{refund.providerRef}</strong><br /><Badge value="refunded">Виконано · симуляція</Badge></p>)}</section>}
      <section className="inspector-section"><h3>Журнал подій</h3><ol className="timeline">{detail.audit.slice().reverse().map(event => <li key={event.id}><strong>{auditLabel(event.type)}</strong><small>{event.actor} · {dateTime(event.createdAt)}</small></li>)}</ol></section>
      <section className="inspector-section"><details><summary>Запуски агента ({detail.runs.length})</summary>{detail.runs.map(run => <div className="run-card" key={run.id}><Badge value={run.status} /><p>{run.provider} · {run.model}</p><p>{run.steps} кроків · {(run.latencyMs / 1000).toLocaleString('uk-UA')} с</p><small>{run.toolCalls.join(', ')}</small>{run.error && <p className="error-text">{run.error}</p>}</div>)}</details></section>
    </aside>
  </>
}

export function ActionCard({ proposal, detail, token, stale, onChanged, compact = false }: { proposal: Proposal; detail: CaseDetail; token: string; stale: boolean; onChanged: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [lockedStatus, setLockedStatus] = useState('')
  const payment = detail.payments.find(item => item.id === proposal.args.payment_id)
  const amount = typeof proposal.args.amount_cents === 'number' ? payment ? money(proposal.args.amount_cents, payment.currency) : `${proposal.args.amount_cents} найменших одиниць валюти` : ''
  const terminal = ['executed', 'failed', 'denied', 'rejected', 'unknown'].includes(proposal.status)
  async function decide(action: 'approve' | 'execute' | 'reject') {
    if (busy || stale || lockedStatus === proposal.status || (uncertain && !terminal)) return
    setBusy(true); setError(''); setNotice('')
    try {
      const latest = await request<CaseDetail>(`/cases/${detail.case.id}`, token)
      const current = latest.proposals.find(item => item.id === proposal.id)
      if (!current || current.argsHash !== proposal.argsHash || current.status !== proposal.status) throw new Error('Стан або аргументи змінилися. Дані оновлено — перегляньте дію ще раз.')
      await request(`/proposals/${proposal.id}/${action}`, token, { method: 'POST', body: action === 'reject' ? { reason: reason.trim() } : { argsHash: proposal.argsHash } })
      setLockedStatus(proposal.status)
      setNotice(action === 'approve' ? 'Погоджено. Виконання потребує окремої дії.' : action === 'execute' ? 'Сервер підтвердив завершення запиту. Результат — у статусі дії та журналі.' : 'Погодження відхилено.')
      setRejecting(false)
    } catch (cause) {
      setError(errorText(cause))
      if (action === 'execute' && !(cause instanceof Error && cause.message.includes('Стан або аргументи'))) setUncertain(true)
    } finally { setBusy(false); onChanged() }
  }
  return <section className={`action-card ${compact ? 'action-card-compact' : ''}`}><div className="action-title"><Icon name="spark" size={18} /><h3>{toolLabels[proposal.tool] ?? proposal.tool}</h3></div>{amount && <strong className="action-amount">{amount}</strong>}<Badge value={proposal.status} /><p className="small">{proposal.policy.requiresApproval ? 'Потребує погодження людини' : 'Політика не вимагає погодження'} · {proposal.risk === 'high' ? 'Високий ризик' : 'Низький ризик'}</p><dl className="facts small"><dt>Клієнт</dt><dd>{detail.customer.name}</dd>{typeof proposal.args.payment_id === 'string' && <><dt>Платіж</dt><dd className="break-word">{proposal.args.payment_id}</dd></>}</dl><details><summary>Точні аргументи дії</summary><pre>{JSON.stringify(proposal.args, null, 2)}</pre><p className="small break-word">Відбиток: {proposal.argsHash}</p></details><ul className="policy-checks">{(compact ? proposal.policy.checks.filter(check => !check.passed) : proposal.policy.checks).map((check, index) => <li key={index}><span className={check.passed ? 'check-pass' : 'check-fail'} aria-hidden="true">{check.passed ? '✓' : '×'}</span><span><strong>{check.passed ? 'Пройдено' : 'Не пройдено'}: {check.name}</strong><small>{check.detail}</small></span></li>)}</ul>{compact && proposal.policy.checks.some(check => check.passed) && <details className="action-passed-checks"><summary>Пройдені перевірки ({proposal.policy.checks.filter(check => check.passed).length})</summary><ul className="policy-checks">{proposal.policy.checks.filter(check => check.passed).map((check, index) => <li key={index}><span className="check-pass" aria-hidden="true">✓</span><span><strong>{check.name}</strong><small>{check.detail}</small></span></li>)}</ul></details>}{proposal.error && <Notice error>{proposal.error}</Notice>}{error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}{uncertain && !terminal && <Notice>Результат уточнюється. Повторне виконання заблоковано. Оновіть дані та перевірте журнал; за потреби зверніться до адміністратора.</Notice>}
      {proposal.status === 'pending' && !uncertain && <div className="action-buttons"><button className="primary" disabled={busy || stale || lockedStatus === proposal.status || !proposal.policy.allowed} onClick={() => void decide('approve')}>{busy ? 'Перевіряємо…' : proposal.tool === 'refund_payment' ? 'Погодити повернення' : 'Погодити дію'}</button><button className="outline-danger" disabled={busy || stale || lockedStatus === proposal.status} onClick={() => setRejecting(value => !value)}>Відхилити</button></div>}
      {proposal.status === 'approved' && !uncertain && <><p className="small">Погодження отримано. Наступний крок виконає дію через сервер.</p><button className="primary full" disabled={busy || stale || lockedStatus === proposal.status} onClick={() => void decide('execute')}>{busy ? 'Виконуємо…' : 'Виконати погоджену дію'}</button></>}
      {rejecting && proposal.status === 'pending' && <form className="reject-form" onSubmit={event => { event.preventDefault(); if (reason.trim()) void decide('reject') }}><label htmlFor={`reject-${proposal.id}`}>Причина відхилення</label><textarea id={`reject-${proposal.id}`} required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /><button disabled={busy || !reason.trim()} type="submit">Підтвердити відхилення</button></form>}
      {proposal.status === 'unknown' && <Notice>Фінансовий результат ще не підтверджено. Автоматичний повтор недоступний; потрібна перевірка оператором.</Notice>}{proposal.status === 'executed' && proposal.tool === 'refund_payment' && <p className="small muted">Повернення виконано симульованим провайдером.</p>}
    </section>
}

function auditLabel(type: string) { const labels: Record<string, string> = { 'case.opened': 'Звернення відкрито', 'message.received': 'Повідомлення отримано', 'agent.analyzed': 'Аналіз AI завершено', 'agent.fallback': 'Застосовано резервні правила', 'action.proposed': 'Дію запропоновано', 'action.denied': 'Політика не дозволила дію', 'action.approved': 'Дію погоджено', 'action.rejected': 'Погодження відхилено', 'action.executed': 'Дію виконано', 'action.failed': 'Дію не виконано', 'case.takeover': 'Діалог узяв оператор', 'case.resumed': 'Діалог повернено AI', 'case.resolved': 'Звернення вирішено', 'operator.message': 'Оператор відповів' }; return labels[type] ?? type }
