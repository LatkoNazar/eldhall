import { DatabaseInvestigationPanel } from './DatabaseInvestigationPanel'
import { useState } from 'react'
import { useI18n } from '../i18n'
import { ApiError, UiError, request } from '../lib/api'
import { validGuard, validGuardConfiguration, type GuardConfiguration, type GuardKind, type GuardRule } from '../lib/banking'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'
import { ErrorNotice } from './ErrorNotice'
import { Icon, Notice } from './ui'

export function GuardsPanel({ token, businessId, currency }: { token: string; businessId: string; currency: string }) {
  const { t } = useI18n()
  const path = `/guards?businessId=${encodeURIComponent(businessId)}`
  const resource = useResource<GuardConfiguration>(path, token)
  const valid = !resource.data || validGuardConfiguration(resource.data)
  return <><DatabaseInvestigationPanel key={businessId} token={token} businessId={businessId} /><section className="card padded guards-section"><h2><Icon name="lock" size={18} />{t('bank.guards.title')}</h2><p>{t('bank.guards.description')}</p>
    {resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}{!valid && <ErrorNotice error={new UiError('core.error.invalidResponse')} />}
    {valid && resource.data && <GuardEditor config={resource.data} path={path} token={token} currency={currency} stale={!!resource.error} onChanged={resource.refresh} />}
  </section></>
}

function GuardEditor({ config, path, token, currency, stale, onChanged }: { config: GuardConfiguration; path: string; token: string; currency: string; stale: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const [rules, setRules] = useState(() => structuredClone(config.rules))
  const [baseline, setBaseline] = useState(() => JSON.stringify(config.rules))
  const [version, setVersion] = useState(config.version)
  const [conflict, setConflict] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dirty = JSON.stringify(rules) !== baseline
  useDirtyForm(dirty)
  const locked = stale || busy || isReadOnlyDemo()
  const changed = conflict || config.version > version
  const valid = rules.every(validGuard)
  function update(id: string, patch: Partial<GuardRule>) { setRules(current => current.map(rule => rule.id === id ? { ...rule, ...patch } : rule)); setSaved(false) }
  function kind(id: string, next: GuardKind) {
    setRules(current => current.map(rule => {
      if (rule.id !== id) return rule
      const base = { id: rule.id, name: rule.name, enabled: rule.enabled, definitionVersion: 1 as const, reason: rule.reason, kind: next, target: next === 'amount_limit' ? { tool: 'refund_payment' as const } : rule.target }
      return next === 'amount_limit' ? { ...base, maxAmountCents: 0, currency } : base
    })); setSaved(false)
  }
  async function save() {
    if (locked || changed || !dirty || !valid) return
    setBusy(true); setError(null); setSaved(false)
    try {
      const result = await request<GuardConfiguration>(path, token, { method: 'PUT', body: { version, rules } })
      if (!validGuardConfiguration(result)) throw new UiError('core.error.invalidResponse')
      setRules(structuredClone(result.rules)); setBaseline(JSON.stringify(result.rules)); setVersion(result.version); setSaved(true); onChanged()
    } catch (cause) { setError(cause); if (cause instanceof ApiError && cause.status === 409) { setConflict(true); onChanged() } }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void save() }}>
    <p className="small muted">{t('bank.guards.revision', { version: config.revision })}</p>
    {rules.map(rule => <fieldset className="guard-rule" key={rule.id} disabled={locked}><legend>{rule.name || t('bank.guards.new')}</legend>
      <label htmlFor={`guard-name-${rule.id}`}>{t('bank.guards.name')}</label><input id={`guard-name-${rule.id}`} required maxLength={100} value={rule.name} onChange={event => update(rule.id, { name: event.target.value })} />
      <label htmlFor={`guard-kind-${rule.id}`}>{t('bank.guards.kind')}</label><select id={`guard-kind-${rule.id}`} value={rule.kind} onChange={event => kind(rule.id, event.target.value as GuardKind)}>{config.definitions.map(definition => <option key={definition.kind} value={definition.kind}>{t(`bank.guards.kind.${definition.kind}`)}</option>)}</select>
      <label htmlFor={`guard-tool-${rule.id}`}>{t('bank.guards.target')}</label><select id={`guard-tool-${rule.id}`} value={rule.target.tool} onChange={event => update(rule.id, { target: { tool: event.target.value as 'refund_payment' | 'external_action' } })}>{config.definitions.find(definition => definition.kind === rule.kind)!.targetTools.map(tool => <option value={tool} key={tool}>{tool === 'refund_payment' ? t('core.tool.refund_payment') : t('bank.guards.external')}</option>)}</select>
      {rule.target.tool === 'external_action' && <><label htmlFor={`guard-integration-${rule.id}`}>{t('bank.guards.integration')}</label><input id={`guard-integration-${rule.id}`} maxLength={64} pattern="[a-zA-Z0-9_.-]+" value={rule.target.integrationId ?? ''} onChange={event => update(rule.id, { target: { ...rule.target, integrationId: event.target.value || undefined } })} /><label htmlFor={`guard-operation-${rule.id}`}>{t('bank.guards.operation')}</label><input id={`guard-operation-${rule.id}`} maxLength={510} value={rule.target.operationKey ?? ''} onChange={event => update(rule.id, { target: { ...rule.target, operationKey: event.target.value || undefined } })} /></>}
      {rule.kind === 'amount_limit' && <><label htmlFor={`guard-amount-${rule.id}`}>{t('bank.guards.amount')}</label><input id={`guard-amount-${rule.id}`} required type="number" min={0} max={100000000} step={1} value={rule.maxAmountCents ?? 0} onChange={event => update(rule.id, { maxAmountCents: Number(event.target.value) })} /><label htmlFor={`guard-currency-${rule.id}`}>{t('bank.guards.currency')}</label><input id={`guard-currency-${rule.id}`} required pattern="[A-Z]{3}" maxLength={3} value={rule.currency ?? currency} onChange={event => update(rule.id, { currency: event.target.value.toUpperCase() })} /></>}
      <label htmlFor={`guard-reason-${rule.id}`}>{t('bank.guards.reason')}</label><textarea id={`guard-reason-${rule.id}`} required maxLength={240} rows={2} value={rule.reason} onChange={event => update(rule.id, { reason: event.target.value })} /><label className="check-option"><input type="checkbox" checked={rule.enabled} onChange={event => update(rule.id, { enabled: event.target.checked })} />{t('bank.guards.enabled')}</label>
      <button type="button" className="outline-danger" onClick={() => { setRules(current => current.filter(item => item.id !== rule.id)); setSaved(false) }}>{t('bank.guards.remove')}</button>
    </fieldset>)}
    <button type="button" disabled={locked || rules.length >= 30} onClick={() => setRules(current => [...current, { id: crypto.randomUUID(), name: '', reason: '', definitionVersion: 1, enabled: true, kind: 'deny_action', target: { tool: 'refund_payment' } }])}><Icon name="plus" size={16} />{t('bank.guards.add')}</button>
    {changed && <><Notice>{t('bank.guards.conflict')} <button type="button" disabled={locked || config.version === version} onClick={() => { setVersion(config.version); setBaseline(JSON.stringify(config.rules)); setConflict(false); setError(null) }}>{t('requests.reviewLatest')}</button></Notice><details open><summary>{t('bank.guards.latest')} · v{config.version}</summary><pre>{JSON.stringify(config.rules, null, 2)}</pre></details></>}{!valid && <p className="field-hint">{t('bank.guards.invalid')}</p>}{error !== null && <ErrorNotice error={error} />}{saved && <Notice>{t('bank.guards.saved')}</Notice>}
    <div className="form-actions"><button type="button" disabled={locked || !dirty} onClick={() => { setRules(structuredClone(config.rules)); setBaseline(JSON.stringify(config.rules)); setVersion(config.version); setConflict(false); setError(null) }}>{t('bank.skills.discard')}</button><button className="primary" disabled={locked || changed || !dirty || !valid}>{busy ? t('operations.common.saving') : t('bank.guards.save')}</button></div>
  </form>
}
