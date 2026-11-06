import { useState } from 'react'
import { useI18n } from '../i18n'
import { ApiError, UiError, request, type CaseDetail } from '../lib/api'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { proposalTitle } from '../lib/external-actions'
import { requestProposals, validRequestCatalog, waitingDependencies, type CustomerRequest, type RequestCatalog, type RequestTransition } from '../lib/request-catalog'
import { ErrorNotice } from './ErrorNotice'
import { Notice } from './ui'

interface Draft { transition: RequestTransition; reason: string; proposalIds: string[]; messageIds: string[]; version: number; revision: number }
export function RequestTransitionForm({ item, catalog, detail, token, stale, onChanged }: { item: CustomerRequest; catalog: RequestCatalog; detail: CaseDetail; token: string; stale: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const linked = requestProposals(item, detail)
  const unsettled = linked.some(proposal => ['executing', 'unknown'].includes(proposal.status))
  const fulfillBlocked = item.lifecycle !== 'open' || waitingDependencies(item, catalog).length > 0 || linked.some(proposal => ['pending', 'approved', 'executing', 'unknown'].includes(proposal.status))
  const evidenceActions = linked.filter(proposal => proposal.status === 'executed' && item.actions.some(link => link.proposalId === proposal.id && link.requestRevision === item.revision))
  const evidenceMessages = detail.messages.filter(message => message.caseId === detail.case.id && ['customer', 'operator'].includes(message.role) && !item.sourceMessageIds.includes(message.id) && Date.parse(message.createdAt) >= Date.parse(item.updatedAt))
  const changed = !!draft && (conflict || draft.version !== catalog.version || draft.revision !== item.revision)
  const invalidProof = !!draft && (draft.proposalIds.some(id => !evidenceActions.some(proposal => proposal.id === id)) || draft.messageIds.some(id => !evidenceMessages.some(message => message.id === id)))
  const blocked = !!draft && (draft.transition === 'fulfill' ? fulfillBlocked : unsettled)
  const locked = isReadOnlyDemo() || stale || busy
  function begin(transition: RequestTransition) {
    setDraft({ transition, reason: '', proposalIds: [], messageIds: [], version: catalog.version, revision: item.revision })
    setConflict(false); setError(null); setSaved(false)
  }
  function toggle(field: 'proposalIds' | 'messageIds', id: string) {
    setDraft(value => value ? { ...value, [field]: value[field].includes(id) ? value[field].filter(other => other !== id) : [...value[field], id] } : value)
  }
  async function submit() {
    if (!draft || locked || changed || blocked || invalidProof || !draft.reason.trim() || (draft.transition === 'fulfill' && !draft.proposalIds.length && !draft.messageIds.length)) return
    const submitted = draft
    setBusy(true); setError(null)
    try {
      const result = await request<{ requestCatalog: RequestCatalog }>(`/cases/${encodeURIComponent(detail.case.id)}/requests/${encodeURIComponent(item.id)}/transition`, token, { method: 'POST', body: { version: submitted.version, revision: submitted.revision, transition: submitted.transition, reason: submitted.reason.trim(), proof: { proposalIds: submitted.transition === 'fulfill' ? submitted.proposalIds : [], messageIds: submitted.transition === 'fulfill' ? submitted.messageIds : [] } } })
      if (!result.requestCatalog || !validRequestCatalog(result.requestCatalog, detail)) throw new UiError('core.error.invalidResponse')
      setDraft(null); setSaved(true); onChanged()
    } catch (cause) { setError(cause); if (cause instanceof ApiError && cause.status === 409) setConflict(true); onChanged() }
    finally { setBusy(false) }
  }
  return <section className="request-transition">
    <div className="request-transition-buttons">{item.lifecycle === 'open' ? <>
      <button type="button" disabled={locked || fulfillBlocked} onClick={() => begin('fulfill')}>{t('requests.transition.fulfill')}</button>
      <button type="button" disabled={locked || unsettled} onClick={() => begin('cancel')}>{t('requests.transition.cancel')}</button>
    </> : <button type="button" disabled={locked || unsettled} onClick={() => begin('reopen')}>{t('requests.transition.reopen')}</button>}</div>
    {saved && <Notice>{t('requests.saved')}</Notice>}
    {draft && <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <h4>{t(`requests.transition.${draft.transition}`)}</h4>
      <label htmlFor={`request-reason-${item.id}`}>{t('requests.reason')}</label>
      <textarea id={`request-reason-${item.id}`} value={draft.reason} maxLength={800} required disabled={locked} onChange={event => setDraft({ ...draft, reason: event.target.value })} />
      {draft.transition === 'fulfill' && <fieldset disabled={locked || changed}><legend>{t('requests.proof')}</legend><p className="field-hint">{t('requests.proofRequired')}</p>
        {evidenceActions.map(proposal => <label className="request-proof" key={proposal.id}><input type="checkbox" checked={draft.proposalIds.includes(proposal.id)} onChange={() => toggle('proposalIds', proposal.id)} />{t('requests.proofAction', { title: proposalTitle(proposal, t) })}</label>)}
        {evidenceMessages.map(message => <label className="request-proof" key={message.id}><input type="checkbox" checked={draft.messageIds.includes(message.id)} onChange={() => toggle('messageIds', message.id)} />{t('requests.proofMessage', { body: message.body.slice(0, 200) })}</label>)}
      </fieldset>}
      {changed && <Notice>{t('requests.stale')} <button type="button" disabled={locked} onClick={() => { setDraft({ ...draft, version: catalog.version, revision: item.revision, proposalIds: draft.proposalIds.filter(id => evidenceActions.some(proposal => proposal.id === id)), messageIds: draft.messageIds.filter(id => evidenceMessages.some(message => message.id === id)) }); setConflict(false); setError(null) }}>{t('requests.reviewLatest')}</button></Notice>}
      {blocked && <Notice>{t('requests.transitionBlocked')}</Notice>}
      {error !== null && <ErrorNotice error={error} />}
      <button type="submit" disabled={locked || changed || blocked || invalidProof || !draft.reason.trim() || (draft.transition === 'fulfill' && !draft.proposalIds.length && !draft.messageIds.length)}>{t('requests.confirm')}</button>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>{t('requests.cancelEdit')}</button>
    </form>}
  </section>
}
