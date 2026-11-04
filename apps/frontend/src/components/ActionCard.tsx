import { currentAnalytics } from '@eldhall/analytics'
import { useEffect, useState } from 'react'
import { Badge, Icon, Notice } from './ui'
import { ApiError, dateTime, errorText, money, request } from '../lib/api'
import type { CaseDetail, Proposal } from '../lib/api'
import { externalInput, isExternalAction, proposalDeadline, proposalTitle } from '../lib/external-actions'

export function ActionCard({ proposal, detail, token, stale, onChanged, compact = false }: { proposal: Proposal; detail: CaseDetail; token: string; stale: boolean; onChanged: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [lockedStatus, setLockedStatus] = useState('')
  const [now, setNow] = useState(Date.now)
  const external = isExternalAction(proposal)
  const deadline = proposalDeadline(proposal)
  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, deadline - Date.now() + 1)))
    return () => window.clearTimeout(timer)
  }, [deadline])
  const expired = deadline !== null && deadline <= now && ['pending', 'approved'].includes(proposal.status)
  const payment = detail.payments.find(item => item.id === proposal.args.payment_id)
  const amount = !external && typeof proposal.args.amount_cents === 'number' ? payment ? money(proposal.args.amount_cents, payment.currency) : `${proposal.args.amount_cents} найменших одиниць валюти` : ''
  const terminal = ['executed', 'failed', 'denied', 'rejected', 'unknown', 'expired', 'invalidated'].includes(proposal.status)
  const locked = busy || stale || lockedStatus === proposal.status || expired
  async function decide(action: 'approve' | 'execute' | 'reject') {
    if (locked || (uncertain && !terminal)) return
    setBusy(true); setError(''); setNotice('')
    try {
      const latest = await request<CaseDetail>(`/cases/${encodeURIComponent(detail.case.id)}`, token)
      const current = latest.proposals.find(item => item.id === proposal.id)
      if (!current || current.argsHash !== proposal.argsHash || current.status !== proposal.status) throw new Error('Стан або аргументи змінилися. Дані оновлено — перегляньте дію ще раз.')
      const result = await request(`/proposals/${encodeURIComponent(proposal.id)}/${action}`, token, { method: 'POST', body: action === 'reject' ? { reason: reason.trim() } : { argsHash: proposal.argsHash } })
      trackDecision(action, proposal.tool, result)
      setLockedStatus(proposal.status)
      setNotice(action === 'approve' ? 'Погоджено. Виконання потребує окремої дії.' : action === 'execute' ? 'Сервер підтвердив завершення запиту. Результат — у статусі дії та журналі.' : 'Погодження відхилено.')
      setRejecting(false)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 502) trackDecision(action, proposal.tool, cause.payload)
      setError(errorText(cause))
      if (action === 'execute' && !(cause instanceof Error && cause.message.includes('Стан або аргументи'))) setUncertain(true)
    } finally { setBusy(false); onChanged() }
  }
  return <section className={`action-card ${compact ? 'action-card-compact' : ''}`}>
    <div className="action-title"><Icon name="spark" size={18} /><h3>{proposalTitle(proposal)}</h3></div>
    {amount && <strong className="action-amount">{amount}</strong>}<Badge value={proposal.status} />
    <p className="small">{proposal.policy.requiresApproval ? 'Потребує погодження людини' : 'Політика не вимагає погодження'} · {proposal.risk === 'high' ? 'Високий ризик' : 'Низький ризик'}</p>
    <dl className="facts small"><dt>Клієнт</dt><dd>{detail.customer.name}</dd>{typeof proposal.args.payment_id === 'string' && <><dt>Платіж</dt><dd className="break-word">{proposal.args.payment_id}</dd></>}{proposal.decidedBy && <><dt>Хто ухвалив рішення</dt><dd>{proposal.decidedBy}</dd></>}</dl>
    {external && <ExternalActionDetails proposal={proposal} />}
    <details><summary>Точні аргументи дії</summary><pre>{JSON.stringify(external ? externalInput(proposal) : proposal.args, null, 2)}</pre><p className="small break-word">Відбиток: {proposal.argsHash}</p></details>
    {external && <details><summary>Версія операції та контекст погодження</summary><pre>{JSON.stringify(proposal.args, null, 2)}</pre></details>}
    <ul className="policy-checks">{(compact ? proposal.policy.checks.filter(check => !check.passed) : proposal.policy.checks).map((check, index) => <li key={index}><span className={check.passed ? 'check-pass' : 'check-fail'} aria-hidden="true">{check.passed ? '✓' : '×'}</span><span><strong>{check.passed ? 'Пройдено' : 'Не пройдено'}: {check.name}</strong><small>{check.detail}</small></span></li>)}</ul>
    {compact && proposal.policy.checks.some(check => check.passed) && <details className="action-passed-checks"><summary>Пройдені перевірки ({proposal.policy.checks.filter(check => check.passed).length})</summary><ul className="policy-checks">{proposal.policy.checks.filter(check => check.passed).map((check, index) => <li key={index}><span className="check-pass" aria-hidden="true">✓</span><span><strong>{check.name}</strong><small>{check.detail}</small></span></li>)}</ul></details>}
    {proposal.error && <Notice error>{proposal.error}</Notice>}{error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    {expired && <Notice error>Строк погодження минув. Потрібна нова пропозиція з актуальними даними.</Notice>}
    {uncertain && !terminal && <Notice>Результат уточнюється. Повторне виконання заблоковано. Оновіть дані та перевірте журнал; за потреби зверніться до адміністратора.</Notice>}
    {proposal.status === 'pending' && !uncertain && proposal.policy.requiresApproval && <div className="action-buttons"><button className="primary" disabled={locked || !proposal.policy.allowed} onClick={() => void decide('approve')}>{busy ? 'Перевіряємо…' : proposal.tool === 'refund_payment' ? 'Погодити повернення' : 'Погодити дію'}</button><button className="outline-danger" disabled={locked} onClick={() => setRejecting(value => !value)}>Відхилити</button></div>}
    {proposal.status === 'pending' && !proposal.policy.requiresApproval && <Notice>Очікує автоматичного виконання за серверною політикою.</Notice>}
    {proposal.status === 'approved' && !uncertain && <><p className="small">Погодження отримано. Наступний крок виконає дію через сервер.</p><button className="primary full" disabled={locked} onClick={() => void decide('execute')}>{busy ? 'Виконуємо…' : 'Виконати погоджену дію'}</button></>}
    {rejecting && proposal.status === 'pending' && <form className="reject-form" onSubmit={event => { event.preventDefault(); if (reason.trim()) void decide('reject') }}><label htmlFor={`reject-${proposal.id}`}>Причина відхилення</label><textarea id={`reject-${proposal.id}`} required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /><button disabled={locked || !reason.trim()} type="submit">Підтвердити відхилення</button></form>}
    {proposal.status === 'unknown' && <Notice>{external ? 'Результат зовнішньої операції не підтверджено.' : 'Фінансовий результат ще не підтверджено.'} Автоматичний повтор недоступний; потрібна перевірка оператором.</Notice>}
    {proposal.status === 'unknown' && external && <ReconcileAction proposal={proposal} caseId={detail.case.id} token={token} stale={stale} onChanged={onChanged} />}
    {proposal.status === 'expired' && <Notice>Строк погодження завершився. Цю дію виконувати більше не можна.</Notice>}
    {proposal.status === 'invalidated' && <Notice>Погодження втратило чинність після зміни правил, каталогу або керування діалогом. Перевірте журнал.</Notice>}
    {proposal.status === 'executed' && proposal.tool === 'refund_payment' && <p className="small muted">Повернення виконано симульованим провайдером.</p>}
    {proposal.status === 'executed' && external && proposal.result && <details><summary>Підтверджений результат операції</summary><pre>{JSON.stringify(proposal.result, null, 2)}</pre></details>}
  </section>
}

// Only confirmed builtin outcomes use the enum-only public event contract.
// Conflicts, stale reads and external operation identifiers never become events.
function trackDecision(action: 'approve' | 'execute' | 'reject', tool: string, result: unknown) {
  if (tool !== 'refund_payment' && tool !== 'escalate_to_human') return
  if (!result || typeof result !== 'object' || !('proposal' in result)) return
  const proposal = result.proposal
  if (!proposal || typeof proposal !== 'object' || !('status' in proposal)) return
  try {
    const analytics = currentAnalytics()
    if (action === 'approve' && proposal.status === 'approved') analytics.track('approval_granted', { tool })
    if (action === 'execute' && proposal.status === 'executed') analytics.track('action_executed', { tool })
    if (action === 'execute' && (proposal.status === 'failed' || proposal.status === 'unknown')) analytics.track('action_failed', { tool, outcome: proposal.status })
  } catch { /* Telemetry never changes the decision or its error/retry protection. */ }
}

function ExternalActionDetails({ proposal }: { proposal: Proposal }) {
  const deadline = proposalDeadline(proposal)
  const parameters = Object.entries(externalInput(proposal)).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 6)
  return <dl className="facts small external-action-meta"><dt>Інтеграція</dt><dd>{String(proposal.args.integrationId ?? '—')}</dd><dt>Ціль операції</dt><dd>{String(proposal.args.operationKey ?? '—')}</dd>{parameters.length > 0 && <><dt>Основні параметри</dt><dd>{parameters.map(([key, value]) => <div key={key}><code>{key}</code>: {String(value)}</div>)}</dd></>}<dt>Тип операції</dt><dd>{proposal.args.effect === 'read' ? 'Читання' : 'Зміна даних'}</dd><dt>Джерело дозволу</dt><dd>{proposal.authorizationOrigin === 'policy_auto' ? 'Auto — серверна політика' : proposal.authorizationOrigin === 'operator_approval' ? 'Погодження оператора' : proposal.policy.requiresApproval ? 'Ask — потрібне погодження оператора' : 'Auto — серверна політика'}</dd><dt>Ревізія політики</dt><dd>{String(proposal.args.policyRevision ?? '—')}</dd><dt>Ревізія підключення</dt><dd>{String(proposal.args.connectionRevision ?? '—')}</dd>{deadline !== null && <><dt>Строк погодження</dt><dd><time dateTime={new Date(deadline).toISOString()}>{dateTime(new Date(deadline).toISOString())} (Київ)</time></dd></>}</dl>
}

function ReconcileAction({ proposal, caseId, token, stale, onChanged }: { proposal: Proposal; caseId: string; token: string; stale: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<'executed' | 'failed'>('executed')
  const [reason, setReason] = useState('')
  const [providerRef, setProviderRef] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  async function reconcile() {
    if (busy || saved || stale || !confirmed || !reason.trim()) return
    setBusy(true); setError('')
    try {
      const current = await request<CaseDetail>(`/cases/${encodeURIComponent(caseId)}`, token)
      const latest = current.proposals.find(item => item.id === proposal.id)
      if (!latest || latest.status !== 'unknown' || latest.argsHash !== proposal.argsHash) throw new Error('Стан дії змінився. Оновіть дані перед звіркою.')
      await request(`/proposals/${encodeURIComponent(proposal.id)}/reconcile`, token, { method: 'POST', body: { status, reason: reason.trim(), ...(providerRef.trim() ? { providerRef: providerRef.trim() } : {}) } })
      setSaved(true); onChanged()
    } catch (cause) { setError(errorText(cause)); onChanged() }
    finally { setBusy(false) }
  }
  return <form className="external-reconcile" onSubmit={event => { event.preventDefault(); void reconcile() }}><h4>Ручна звірка результату</h4><p className="field-hint">Спершу перевірте операцію в зовнішній системі. Ця дія лише записує підтверджений результат і не повторює запит до провайдера.</p><label htmlFor={`reconcile-status-${proposal.id}`}>Підтверджений стан</label><select id={`reconcile-status-${proposal.id}`} disabled={stale || busy || saved} value={status} onChange={event => setStatus(event.target.value as 'executed' | 'failed')}><option value="executed">Виконано</option><option value="failed">Не виконано</option></select><label htmlFor={`reconcile-reason-${proposal.id}`}>Підстава звірки</label><textarea id={`reconcile-reason-${proposal.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required disabled={stale || busy || saved} /><label htmlFor={`reconcile-ref-${proposal.id}`}>Ідентифікатор у провайдера (необов’язково)</label><input id={`reconcile-ref-${proposal.id}`} value={providerRef} onChange={event => setProviderRef(event.target.value)} maxLength={200} disabled={stale || busy || saved} /><label className="integration-review-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={stale || busy || saved} />Я перевірив(ла) фактичний результат у зовнішній системі</label>{error && <Notice error>{error}</Notice>}{saved && <Notice>Підтверджений результат звірки записано.</Notice>}<button type="submit" disabled={stale || busy || saved || !confirmed || !reason.trim()}>{busy ? 'Записуємо…' : 'Записати результат звірки'}</button></form>
}
