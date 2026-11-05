import { useI18n, type UiMessage } from '../i18n'
import { ProposalContext } from './ProposalContext'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { validCurrency } from '../lib/presentation'
import { ErrorNotice } from './ErrorNotice'
import { currentAnalytics } from '@eldhall/analytics'
import { useEffect, useState } from 'react'
import { Badge, Icon, Notice } from './ui'
import { ApiError, UiError, dateTime, money, request } from '../lib/api'
import type { CaseDetail, Proposal } from '../lib/api'
import { externalInput, isExternalAction, proposalDeadline, proposalTitle } from '../lib/external-actions'

export function ActionCard({ proposal, detail, token, stale, onChanged, compact = false }: { proposal: Proposal; detail: CaseDetail; token: string; stale: boolean; onChanged: () => void; compact?: boolean }) {
  const { t, locale, translateMessage } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<UiMessage | null>(null)
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
  const amount = proposal.tool === 'refund_payment' && typeof proposal.args.amount_cents === 'number' && Number.isSafeInteger(proposal.args.amount_cents) && proposal.args.amount_cents >= 0 && payment && validCurrency(payment.currency) ? money(proposal.args.amount_cents, payment.currency, locale) : ''
  const terminal = ['executed', 'failed', 'denied', 'rejected', 'unknown', 'expired', 'invalidated'].includes(proposal.status)
  const locked = isReadOnlyDemo() || busy || stale || lockedStatus === proposal.status || expired
  async function decide(action: 'approve' | 'execute' | 'reject') {
    if (locked || (uncertain && !terminal)) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const latest = await request<CaseDetail>(`/cases/${encodeURIComponent(detail.case.id)}`, token)
      const current = latest.proposals.find(item => item.id === proposal.id)
      if (!current || current.argsHash !== proposal.argsHash || current.status !== proposal.status) throw new UiError('core.action.changed')
      const result = await request(`/proposals/${encodeURIComponent(proposal.id)}/${action}`, token, { method: 'POST', body: action === 'reject' ? { reason: reason.trim() } : { argsHash: proposal.argsHash } })
      trackDecision(action, proposal.tool, result)
      setLockedStatus(proposal.status)
      setNotice({ key: action === 'approve' ? 'core.action.approvedNotice' : action === 'execute' ? 'core.action.executedNotice' : 'core.action.rejectedNotice' })
      setRejecting(false)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 502) trackDecision(action, proposal.tool, cause.payload)
      setError(cause)
      if (action === 'execute' && !(cause instanceof UiError && cause.key === 'core.action.changed')) setUncertain(true)
    } finally { setBusy(false); onChanged() }
  }
  return <section className={`action-card ${compact ? 'action-card-compact' : ''}`}>
    <div className="action-title"><Icon name="spark" size={18} /><h3>{proposalTitle(proposal, t)}</h3></div>
    {amount && <strong className="action-amount">{amount}</strong>}<Badge value={proposal.status} />
    <p className="small">{proposal.policy.requiresApproval ? t("core.action.requiresApproval") : t("core.action.noApproval")} · {proposal.risk === 'high' ? t("core.action.highRisk") : t("core.action.lowRisk")}</p>
    <ProposalContext proposal={proposal} detail={detail} />
    <ul className="policy-checks">{(compact ? proposal.policy.checks.filter(check => !check.passed) : proposal.policy.checks).map((check, index) => <li key={index}><span className={check.passed ? 'check-pass' : 'check-fail'} aria-hidden="true">{check.passed ? '✓' : '×'}</span><span><strong>{check.passed ? t("core.action.passed") : t("core.action.notPassed")}: {check.name}</strong><small>{check.detail}</small></span></li>)}</ul>
    {compact && proposal.policy.checks.some(check => check.passed) && <details className="action-passed-checks"><summary>{t("core.action.passedChecksPrefix")}{proposal.policy.checks.filter(check => check.passed).length})</summary><ul className="policy-checks">{proposal.policy.checks.filter(check => check.passed).map((check, index) => <li key={index}><span className="check-pass" aria-hidden="true">✓</span><span><strong>{check.name}</strong><small>{check.detail}</small></span></li>)}</ul></details>}
    {proposal.error && <ErrorNotice error={new ApiError(502, proposal.error, { proposal: { status: proposal.status } }, undefined, proposal.error)} />}{error !== null && <ErrorNotice error={error} />}{notice && <Notice>{translateMessage(notice)}</Notice>}
    {expired && <Notice error>{t("core.action.expiredNotice")}</Notice>}
    {uncertain && !terminal && <Notice>{t("core.action.uncertain")}</Notice>}
    {proposal.status === 'pending' && !uncertain && proposal.policy.requiresApproval && <div className="action-buttons"><button className="primary" disabled={locked || !proposal.policy.allowed} onClick={() => void decide('approve')}>{busy ? t("core.common.checking") : proposal.tool === 'refund_payment' ? t("core.action.approveRefund") : t("core.action.approve")}</button><button className="outline-danger" disabled={locked} onClick={() => setRejecting(value => !value)}>{t("core.common.reject")}</button></div>}
    {proposal.status === 'pending' && !proposal.policy.requiresApproval && <Notice>{t("core.action.autoPending")}</Notice>}
    {proposal.status === 'approved' && !uncertain && <><p className="small">{t("core.action.executionHint")}</p><button className="primary full" disabled={locked} onClick={() => void decide('execute')}>{busy ? t("core.action.executing") : t("core.action.execute")}</button></>}
    {rejecting && proposal.status === 'pending' && <form className="reject-form" onSubmit={event => { event.preventDefault(); if (reason.trim()) void decide('reject') }}><label htmlFor={`reject-${proposal.id}`}>{t("core.action.rejectReason")}</label><textarea id={`reject-${proposal.id}`} required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /><button disabled={locked || !reason.trim()} type="submit">{t("core.action.confirmReject")}</button></form>}
    {proposal.status === 'unknown' && <Notice>{external ? t("core.action.externalUnknown") : t("core.action.paymentUnknown")}  {t("core.action.noRetry")}</Notice>}
    {proposal.status === 'unknown' && external && <ReconcileAction proposal={proposal} caseId={detail.case.id} token={token} stale={stale} onChanged={onChanged} />}
    {proposal.status === 'expired' && <Notice>{t("core.action.expiredTerminal")}</Notice>}
    {proposal.status === 'invalidated' && <Notice>{t("core.action.invalidatedNotice")}</Notice>}
    <details className="action-technical"><summary>{t("presentation.references")}</summary>
    <dl className="facts small"><dt>{t("core.common.customer")}</dt><dd>{detail.customer.name}</dd>{typeof proposal.args.payment_id === 'string' && <><dt>{t("core.action.payment")}</dt><dd className="break-word">{proposal.args.payment_id}</dd></>}{proposal.decidedBy && <><dt>{t("core.action.decidedBy")}</dt><dd>{proposal.decidedBy}</dd></>}</dl>
    {external && <ExternalActionDetails proposal={proposal} />}
    </details>
    <details><summary>{t("core.action.arguments")}</summary><pre>{JSON.stringify(external ? externalInput(proposal) : proposal.args, null, 2)}</pre><p className="small break-word">{t("core.action.fingerprint")} {proposal.argsHash}</p></details>
    {external && <details><summary>{t("core.action.context")}</summary><pre>{JSON.stringify(proposal.args, null, 2)}</pre></details>}
    {proposal.status === 'executed' && proposal.tool === 'refund_payment' && <p className="small muted">{t("core.action.simulatedRefund")}</p>}
    {proposal.status === 'executed' && external && proposal.result && <details><summary>{t("core.action.result")}</summary><pre>{JSON.stringify(proposal.result, null, 2)}</pre></details>}
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
  const { t, locale } = useI18n()
  const deadline = proposalDeadline(proposal)
  return <dl className="facts small external-action-meta"><dt>{t("core.action.integration")}</dt><dd>{String(proposal.args.integrationId ?? '—')}</dd><dt>{t("core.action.target")}</dt><dd>{String(proposal.args.operationKey ?? '—')}</dd><dt>{t("core.action.effect")}</dt><dd>{proposal.args.effect === 'read' ? t("core.action.read") : t("core.action.write")}</dd><dt>{t("core.action.permissionSource")}</dt><dd>{proposal.authorizationOrigin === 'policy_auto' ? t("core.action.autoOrigin") : proposal.authorizationOrigin === 'operator_approval' ? t("core.action.operatorOrigin") : proposal.policy.requiresApproval ? t("core.action.askOrigin") : t("core.action.autoOrigin")}</dd><dt>{t("core.action.policyRevision")}</dt><dd>{String(proposal.args.policyRevision ?? '—')}</dd><dt>{t("core.action.connectionRevision")}</dt><dd>{String(proposal.args.connectionRevision ?? '—')}</dd>{deadline !== null && <><dt>{t("core.action.expiry")}</dt><dd><time dateTime={new Date(deadline).toISOString()}>{dateTime(new Date(deadline).toISOString(), locale)}  {t("core.common.kyiv")}</time></dd></>}</dl>
}

function ReconcileAction({ proposal, caseId, token, stale, onChanged }: { proposal: Proposal; caseId: string; token: string; stale: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'executed' | 'failed'>('executed')
  const [reason, setReason] = useState('')
  const [providerRef, setProviderRef] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function reconcile() {
    if (isReadOnlyDemo() || busy || saved || stale || !confirmed || !reason.trim()) return
    setBusy(true); setError(null)
    try {
      const current = await request<CaseDetail>(`/cases/${encodeURIComponent(caseId)}`, token)
      const latest = current.proposals.find(item => item.id === proposal.id)
      if (!latest || latest.status !== 'unknown' || latest.argsHash !== proposal.argsHash) throw new UiError('core.action.reconcileChanged')
      await request(`/proposals/${encodeURIComponent(proposal.id)}/reconcile`, token, { method: 'POST', body: { status, reason: reason.trim(), ...(providerRef.trim() ? { providerRef: providerRef.trim() } : {}) } })
      setSaved(true); onChanged()
    } catch (cause) { setError(cause); onChanged() }
    finally { setBusy(false) }
  }
  return <form className="external-reconcile" onSubmit={event => { event.preventDefault(); void reconcile() }}><h4>{t("core.action.reconcileTitle")}</h4><p className="field-hint">{t("core.action.reconcileHint")}</p><label htmlFor={`reconcile-status-${proposal.id}`}>{t("core.action.confirmedStatus")}</label><select id={`reconcile-status-${proposal.id}`} disabled={isReadOnlyDemo() || stale || busy || saved} value={status} onChange={event => setStatus(event.target.value as 'executed' | 'failed')}><option value="executed">{t("core.status.executed")}</option><option value="failed">{t("core.status.failed")}</option></select><label htmlFor={`reconcile-reason-${proposal.id}`}>{t("core.action.reconcileReason")}</label><textarea id={`reconcile-reason-${proposal.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required disabled={isReadOnlyDemo() || stale || busy || saved} /><label htmlFor={`reconcile-ref-${proposal.id}`}>{t("core.action.providerReference")}</label><input id={`reconcile-ref-${proposal.id}`} value={providerRef} onChange={event => setProviderRef(event.target.value)} maxLength={200} disabled={isReadOnlyDemo() || stale || busy || saved} /><label className="integration-review-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={isReadOnlyDemo() || stale || busy || saved} />{t("core.action.verified")}</label>{error !== null && <ErrorNotice error={error} />}{saved && <Notice>{t("core.action.reconciledNotice")}</Notice>}<button type="submit" disabled={isReadOnlyDemo() || stale || busy || saved || !confirmed || !reason.trim()}>{busy ? t("core.common.saving") : t("core.action.reconcile")}</button></form>
}
