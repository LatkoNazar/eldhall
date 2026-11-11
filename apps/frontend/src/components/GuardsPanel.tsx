import { useEffect, useRef, useState } from 'react'
import { formatMoney, useI18n } from '../i18n'
import { ApiError, UiError, request } from '../lib/api'
import { validGuard, validGuardConfiguration, type GuardConfiguration, type GuardRule } from '../lib/banking'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'
import { AppLink } from './AppLink'
import { ErrorNotice } from './ErrorNotice'
import { Badge, Icon, Notice } from './ui'

export function GuardsPanel({ token, businessId }: { token: string; businessId: string }) {
  const query = `?businessId=${encodeURIComponent(businessId)}`
  const resource = useResource<GuardConfiguration>(`/guards${query}`, token)
  const valid = !resource.data || validGuardConfiguration(resource.data)
  const { t } = useI18n()
  return <section className="card padded guards-section">
    {resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}
    {!valid && <ErrorNotice error={new UiError('core.error.invalidResponse')} />}
    {valid && resource.data
      ? <GuardEditor config={resource.data} query={query} token={token} stale={!!resource.error} onChanged={resource.refresh} />
      : <GuardHeading />}
  </section>
}

function GuardHeading() {
  const { t } = useI18n()
  return <div><h2>{t('bank.guards.title')}</h2><p>{t('bank.guards.description')}</p></div>
}

function GuardEffect({ rule }: { rule: GuardRule }) {
  const { t, locale } = useI18n()
  const scope = [rule.target.integrationId, rule.target.operationKey].filter(Boolean).join(' / ')
  const target = rule.target.tool === 'refund_payment' ? t('core.tool.refund_payment') : t(scope ? 'bank.guards.external' : 'bank.guards.allExternal')
  const amount = rule.maxAmountCents !== undefined && rule.currency ? formatMoney(rule.maxAmountCents, rule.currency, locale) : null
  return <p className="guard-effect">{t(`bank.guards.kind.${rule.kind}`)} · {target}{amount && <> · {amount}</>}{scope && <> · <code>{scope}</code></>}</p>
}

type Editor = { id?: string; description: string; draft?: GuardRule; version?: number }
type Confirmation = { type: 'remove'; id: string; version: number } | { type: 'discard' }

function GuardConfirmation({ message, action, onConfirm, onCancel, busy = false, disabled = false }: {
  message: string; action: string; onConfirm: () => void; onCancel: () => void; busy?: boolean; disabled?: boolean
}) {
  const { t } = useI18n()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  return <div className="guard-confirmation" role="group" aria-labelledby="guard-confirmation-message" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel() }
  }}>
    <p id="guard-confirmation-message">{message}</p>
    <div className="guard-actions">
      <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>{t('operations.common.cancel')}</button>
      <button type="button" className="outline-danger" disabled={busy || disabled} onClick={onConfirm}>
        {busy ? t('operations.common.saving') : action}
      </button>
    </div>
  </div>
}

function draftError(error: unknown) {
  if (!(error instanceof ApiError)) return error
  if (error.status === 502) return new UiError('bank.guards.draftError')
  if (error.status !== 422 || !error.payload || typeof error.payload !== 'object' || !('code' in error.payload)) return error
  switch (error.payload.code) {
    case 'guard_draft_unsupported': return new UiError('bank.guards.draftUnsupported')
    case 'guard_draft_duplicate': return new UiError('bank.guards.draftDuplicate')
    case 'guard_draft_currency': return new UiError('bank.guards.draftCurrency')
    case 'guard_draft_target': return new UiError('bank.guards.draftTarget')
    case 'guard_draft_context': return new UiError('bank.guards.draftContext')
    case 'guard_draft_limit': return new UiError('bank.guards.draftLimit')
    default: return error
  }
}

function GuardEditor({ config, query, token, stale, onChanged }: {
  config: GuardConfiguration; query: string; token: string; stale: boolean; onChanged: () => void
}) {
  const { t } = useI18n()
  const [saved, setSaved] = useState<GuardConfiguration | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [conflict, setConflict] = useState<number | null>(null)
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const removalOpener = useRef<HTMLButtonElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const current = saved && saved.version > config.version ? saved : config
  const canGenerate = current.canGenerate === true
  const dirty = !!editor?.description.trim()
  const locked = stale || busy !== null || isReadOnlyDemo()
  const needsRefresh = conflict !== null && current.version <= conflict
  const outdated = !!editor?.draft && editor.version !== current.version
  const original = editor?.id ? current.rules.find(rule => rule.id === editor.id) : undefined
  const missing = !!editor?.id && !original
  const editing = editor !== null
  const discarding = confirmation?.type === 'discard'
  const removal = confirmation?.type === 'remove' && current.rules.some(rule => rule.id === confirmation.id) ? confirmation : null
  useDirtyForm(dirty)
  useEffect(() => {
    if (editing) descriptionField.current?.focus()
    else opener.current?.focus()
  }, [editing])
  useEffect(() => {
    if (removal || !removalOpener.current) return
    const button = removalOpener.current
    removalOpener.current = null
    if (button.isConnected && !button.disabled) button.focus()
    else toolbar.current?.focus()
  }, [removal])

  function open(button: HTMLButtonElement, id?: string) {
    opener.current = button
    setEditor({ id, description: '' }); setError(null)
  }
  function close() {
    setEditor(null); setError(null)
  }
  async function generate() {
    if (!editor || discarding || !canGenerate || locked || needsRefresh || missing || editor.description.trim().length < 10) return
    setBusy('generate'); setError(null)
    try {
      const result = await request<{ guard: unknown }>(`/guards/draft${query}`, token, {
        method: 'POST', body: { description: editor.description.trim(), ...(original ? { guardId: original.id } : {}) },
      })
      const draft = result?.guard
      if (!validGuard(draft) || (original ? draft.id !== original.id || draft.enabled !== original.enabled
        : draft.enabled || current.rules.some(rule => rule.id === draft.id))) throw new UiError('core.error.invalidResponse')
      setEditor({ ...editor, draft, version: current.version })
    } catch (cause) {
      setError(draftError(cause))
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) onChanged()
    } finally { setBusy(null) }
  }
  async function persist(rules: GuardRule[], closeEditor = false) {
    if (locked || needsRefresh) return
    setBusy('save'); setError(null)
    try {
      const result = await request<GuardConfiguration>(`/guards${query}`, token, { method: 'PUT', body: { version: current.version, rules } })
      if (!validGuardConfiguration(result) || result.version <= current.version) throw new UiError('core.error.invalidResponse')
      setSaved(result); setConflict(null)
      if (closeEditor) setEditor(null)
      onChanged()
    } catch (cause) {
      setError(cause)
      if (cause instanceof ApiError && cause.status === 409) { setConflict(current.version); onChanged() }
    } finally { setBusy(null) }
  }
  function saveDraft() {
    if (!editor?.draft || outdated || needsRefresh || missing) return
    const { draft } = editor
    void persist(original ? current.rules.map(rule => rule.id === draft.id ? draft : rule) : [...current.rules, draft], true)
  }
  async function removeRule() {
    if (!removal || locked || needsRefresh || removal.version !== current.version) return
    await persist(current.rules.filter(rule => rule.id !== removal.id))
    setConfirmation(null)
  }

  return <>
    <div className="guard-toolbar" ref={toolbar} tabIndex={-1}><GuardHeading />
      {canGenerate && <button type="button" className="primary" disabled={locked || needsRefresh || editing || !!removal || current.rules.length >= 30} onClick={event => open(event.currentTarget)}><Icon name="plus" size={16} />{t('bank.guards.add')}</button>}
    </div>
    {!canGenerate && <p className="small muted">{t('bank.guards.modelRequired')}</p>}
    {needsRefresh && <Notice>{t('bank.guards.conflict')} <button type="button" disabled={locked} onClick={onChanged}>{t('core.common.retryRead')}</button></Notice>}
    {error !== null && !editor && <ErrorNotice error={error} />}
    {editor && <form className="guard-author" aria-labelledby="guard-author-heading" onSubmit={event => { event.preventDefault(); void generate() }}>
      <h3 id="guard-author-heading">{original?.name ?? t('bank.guards.new')}</h3>
      <label htmlFor="guard-description">{t(editor.id ? 'bank.guards.describeChange' : 'bank.guards.describe')}</label>
      <textarea ref={descriptionField} id="guard-description" aria-describedby="guard-description-help" value={editor.description} required minLength={10} maxLength={6000} rows={3} disabled={locked || missing}
        placeholder={t('bank.guards.example')} onChange={event => { setEditor({ ...editor, description: event.target.value, draft: undefined }); setError(null) }} />
      <p id="guard-description-help" className="field-hint">{t('bank.guards.replyGuidance')}{' '}
        <AppLink href="/operator/settings?section=skills">{t('bank.guards.openSkills')}</AppLink>
      </p>
      {error !== null && <ErrorNotice error={error} />}
      {editor.draft && <div className="guard-preview">
        <p className="small muted">{t('bank.skills.reviewDraft')}</p>
        <strong>{editor.draft.name}</strong>
        <GuardEffect rule={editor.draft} />
        <p className="small">{editor.draft.reason}</p>
        {!editor.id && <p className="small muted">{t('bank.guards.savedDisabled')}</p>}
        {original?.enabled && <p className="small muted">{t('bank.guards.editApplies')}</p>}
      </div>}
      {missing ? <Notice>{t('bank.guards.missing')}</Notice> : outdated && <Notice>{t('bank.guards.regenerate')}</Notice>}
      {discarding ? <GuardConfirmation message={t('bank.guards.confirmDiscard')} action={t('bank.skills.discard')}
        onCancel={() => { setConfirmation(null); descriptionField.current?.focus() }}
        onConfirm={() => { setConfirmation(null); close() }} /> : <div className="guard-actions">
        <button type="button" disabled={busy !== null} onClick={() => { if (dirty) setConfirmation({ type: 'discard' }); else close() }}>{t('operations.common.cancel')}</button>
        {(!editor.draft || outdated) && <button className="primary" disabled={locked || !canGenerate || missing || needsRefresh || editor.description.trim().length < 10}>{t(busy === 'generate' ? 'bank.skills.generating' : 'bank.skills.generate')}</button>}
        {editor.draft && !outdated && <button type="button" className="primary" disabled={locked || missing || needsRefresh} onClick={saveDraft}>{t(busy === 'save' ? 'operations.common.saving' : editor.id ? 'bank.guards.save' : 'bank.skills.saveDraft')}</button>}
      </div>}
    </form>}
    {current.rules.length ? <ul className="guard-list">
      {current.rules.map(rule => <li className="guard-rule" key={rule.id}>
        <div className="guard-summary">
          <div className="guard-rule-title"><strong>{rule.name}</strong><Badge value={rule.enabled ? 'ok' : 'neutral'}>{t(rule.enabled ? 'bank.guards.active' : 'bank.guards.inactive')}</Badge></div>
          <GuardEffect rule={rule} />
          <details className="guard-reason"><summary>{t('bank.guards.reason')}</summary><p>{rule.reason}</p></details>
        </div>
        <div className="guard-actions" hidden={removal?.id === rule.id}>
          {canGenerate && <button type="button" disabled={locked || needsRefresh || editing || !!removal} onClick={event => open(event.currentTarget, rule.id)}>{t('bank.guards.edit')}</button>}
          <button type="button" disabled={locked || needsRefresh || editing || !!removal}
            onClick={() => void persist(current.rules.map(row => row.id === rule.id ? { ...row, enabled: !row.enabled } : row))}>{t(rule.enabled ? 'bank.guards.disable' : 'bank.guards.enable')}</button>
          <button type="button" className="outline-danger" disabled={locked || needsRefresh || editing || !!removal} onClick={event => {
            removalOpener.current = event.currentTarget
            setError(null)
            setConfirmation({ type: 'remove', id: rule.id, version: current.version })
          }}>{t('bank.guards.remove')}</button>
        </div>
        {removal?.id === rule.id && <GuardConfirmation
          message={t(removal.version === current.version ? 'bank.guards.confirmRemove' : 'core.error.conflict', { name: rule.name })}
          action={t('bank.guards.remove')} busy={busy === 'save'} disabled={locked || needsRefresh || removal.version !== current.version}
          onConfirm={() => void removeRule()} onCancel={() => setConfirmation(null)} />}
      </li>)}
    </ul> : <p className="small muted">{t('bank.guards.empty')}</p>}
  </>
}
