import { WorkspaceProvider } from '../components/WorkspaceProvider'
import { useI18n, formatDateTime, type UiMessage } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { ApiError, request } from '../lib/api'
import { decisionLabel, integrationPath, loadIntegration, loadIntegrations, modeLabel } from '../lib/integrations-api'
import type { CatalogOperation, IntegrationCatalog, IntegrationPolicy, IntegrationPolicyResponse, IntegrationSummary, PermissionGroup, PermissionMode, RuleMode } from '../lib/integrations-api'
import { registerNavigationGuard } from '../lib/navigation'

interface Draft { defaultMode: PermissionMode; groups: PermissionGroup[]; operations: { operationKey: string; mode: RuleMode }[] }
const toDraft = (policy: IntegrationPolicy, operations: CatalogOperation[]): Draft => ({ defaultMode: policy.defaultMode, groups: structuredClone(policy.groups), operations: operations.map(({ operationKey }) => ({ operationKey, mode: policy.operations.find(rule => rule.operationKey === operationKey)?.mode ?? 'inherit' })) })
const effectLabel = { read: "operations.integrations.readEffect", write: "operations.integrations.writeEffect", unknown: "operations.integrations.unknownEffect" } as const

export function Integrations({ token }: { token: string }) {
  const { t } = useI18n()
  const dirtyRef = useRef(false)
  return <WorkspaceProvider token={token}>{business => <>
    <div className="page-heading"><div><h1>{t("operations.integrations.title")}</h1><p>{t("operations.integrations.description")}</p></div></div>
    <p className="muted small">{t("operations.integrations.adminScope")}</p>
    <IntegrationList key={business.id} businessId={business.id} token={token} dirtyRef={dirtyRef} />
  </>}</WorkspaceProvider>
}

function IntegrationList({ businessId, token, dirtyRef }: { businessId: string; token: string; dirtyRef: { current: boolean } }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ data: IntegrationSummary[] | null; error: unknown | null }>({ data: null, error: null })
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('integrationId') ?? '')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadIntegrations(businessId, token, controller.signal).then(data => { if (!controller.signal.aborted) setState({ data: data.integrations, error: null }) }).catch(cause => { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: cause })) })
    return () => controller.abort()
  }, [businessId, token, revision])
  const active = state.data?.find(item => item.integrationId === selected) ?? state.data?.[0]
  return <>
    {Boolean(state.error) && <ErrorNotice error={state.error}> <button onClick={() => setRevision(value => value + 1)}>{t("operations.integrations.refresh")}</button></ErrorNotice>}
    {state.data?.length ? <><div className="integration-picker"><label htmlFor="integration-select">{t("operations.integrations.integration")}</label><select id="integration-select" value={active?.integrationId ?? ''} onChange={event => { if (!dirtyRef.current || window.confirm(t("operations.integrations.discardPrompt"))) setSelected(event.target.value) }}>{state.data.map(item => <option key={item.integrationId} value={item.integrationId}>{item.integrationId} · {item.draining ? t("operations.integrations.draining") : item.enabled ? t("operations.integrations.active") : t("operations.integrations.disabled")}</option>)}</select></div>{active && <IntegrationEditor key={active.integrationId} id={active.integrationId} businessId={businessId} token={token} dirtyRef={dirtyRef} onChanged={() => setRevision(value => value + 1)} />}</> : !state.error && <div className="card"><Empty icon="settings" title={state.data ? t("operations.integrations.noCatalogs") : t("operations.integrations.loading")}>{t("operations.integrations.deploymentHint")}</Empty></div>}
  </>
}

function IntegrationEditor({ id, businessId, token, dirtyRef, onChanged }: { id: string; businessId: string; token: string; dirtyRef: { current: boolean }; onChanged: () => void }) {
  const { t, locale, translateMessage } = useI18n()
  const [data, setData] = useState<{ catalog: IntegrationCatalog; policy: IntegrationPolicyResponse } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  const [notice, setNotice] = useState<UiMessage | null>(null)
  const [conflict, setConflict] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState<CatalogOperation | null>(null)
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [newGroupId, setNewGroupId] = useState('')
  const load = useCallback((signal?: AbortSignal) => loadIntegration(id, businessId, token, signal)
    .then(result => {
      if (!signal?.aborted) { setData(result); setDraft(toDraft(result.policy.policy, result.catalog.operations)); setConflict(false); setError(null) }
      return true
    })
    .catch(cause => { if (!signal?.aborted) { setError(cause); if (cause instanceof ApiError && cause.status === 409) setConflict(true) }; return false })
    .finally(() => { if (!signal?.aborted) setLoading(false) }), [id, businessId, token])
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])
  const isDirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(data.policy.policy, data.catalog.operations))
  useEffect(() => {
    dirtyRef.current = isDirty
    const remove = registerNavigationGuard(() => !isDirty || window.confirm(t("operations.integrations.discardPrompt")))
    const beforeUnload = (event: BeforeUnloadEvent) => { if (isDirty) { event.preventDefault() } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { remove(); dirtyRef.current = false; window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirtyRef, isDirty, t])
  const blocked = loading || busy || !!error || conflict
  function setOperationMode(operationKey: string, mode: RuleMode) {
    setDraft(current => current ? { ...current, operations: current.operations.map(rule => rule.operationKey === operationKey ? { ...rule, mode } : rule) } : current)
  }
  async function mutate(suffix: string, body: Record<string, unknown>, method = 'POST') {
    if (!data || blocked) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await request(integrationPath(id, businessId, suffix), token, { method, body: { ...body, version: data.policy.integration.version } })
      setLoading(true); const reloaded = await load()
      setReviewing(null)
      onChanged()
      setNotice({ key: reloaded ? "operations.integrations.savedReloaded" : "operations.integrations.savedNotReloaded" })
    } catch (cause) {
      setError(cause)
      setReviewing(null)
      if (cause instanceof ApiError && cause.status === 409) setConflict(true)
    } finally { setBusy(false) }
  }
  function refresh() { if (!isDirty || window.confirm(t("operations.integrations.reloadPrompt"))) { setReviewing(null); setLoading(true); void load() } }
  if (!data || !draft) return <>{Boolean(error) && <ErrorNotice error={error}> <button onClick={refresh}>{t("operations.integrations.reloadPolicy")}</button></ErrorNotice>}<div className="card"><Empty title={loading ? t("operations.integrations.loadingCatalog") : t("operations.integrations.catalogUnavailable")} /></div></>
  const integration = data.policy.integration
  const operations = data.catalog.operations.filter(operation => `${operation.title} ${operation.operationKey} ${operation.tags.join(' ')}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
  const tags = [...new Set(data.catalog.operations.flatMap(operation => operation.tags))].sort()
  return <>
    <section className="card padded integration-summary">
      <div className="page-heading"><div><h2>{id}</h2><Badge value={integration.enabled ? 'ok' : 'draft'}>{integration.draining ? t("operations.integrations.finishingCalls") : integration.enabled ? t("operations.integrations.active") : t("operations.integrations.disabled")}</Badge></div><button disabled={busy || loading} onClick={refresh}><Icon name="refresh" />{t("operations.integrations.reloadPolicy")}</button></div>
      <dl className="facts"><dt>{t("operations.integrations.editVersion")}</dt><dd>{integration.version}</dd><dt>{t("operations.integrations.policyRevision")}</dt><dd>{integration.policyRevision}</dd><dt>{t("operations.integrations.connectionRevision")}</dt><dd className="break-word">{integration.connectionRevision}</dd><dt>{t("operations.integrations.loadedManifest")}</dt><dd className="break-word"><code>{integration.loadedManifestHash}</code></dd><dt>{t("operations.integrations.activeManifest")}</dt><dd className="break-word"><code>{integration.activeManifestHash ?? t("operations.integrations.notActivated")}</code></dd><dt>{t("operations.common.updated")}</dt><dd>{formatDateTime(integration.updatedAt, locale)}</dd></dl>
      <div className="integration-controls"><button disabled={blocked || isDirty || (integration.enabled && integration.activeManifestHash === integration.loadedManifestHash)} onClick={() => void mutate('/activate', { manifestHash: integration.loadedManifestHash, connectionRevision: integration.connectionRevision })}>{t("operations.integrations.activate")}</button><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: false })}>{t("operations.integrations.disable")}</button><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: true })}>{t("operations.integrations.finishCalls")}</button></div>
      <p className="field-hint">{t("operations.integrations.activationHint")}</p>
    </section>
    {Boolean(error) && <ErrorNotice error={error}>{conflict && <p>{t('operations.integrations.versionConflict')}</p>} <button disabled={busy || loading} onClick={refresh}>{t("operations.integrations.reloadPolicy")}</button></ErrorNotice>}
    {notice && <Notice>{translateMessage(notice)}</Notice>}
    <form className="card padded integration-policy" onSubmit={event => { event.preventDefault(); void mutate('/policy', { defaultMode: draft.defaultMode, groups: draft.groups, operations: draft.operations }, 'PATCH') }}>
      <div className="page-heading"><div><h2>{t("operations.integrations.executionRules")}</h2><p>{t("operations.integrations.permissionHint")}</p></div><button className="primary" type="submit" disabled={blocked || !isDirty}>{t("operations.integrations.saveRules")}</button></div>
      <label htmlFor="integration-default-mode">{t("operations.integrations.defaultPermission")}</label><select id="integration-default-mode" disabled={blocked} value={draft.defaultMode} onChange={event => setDraft({ ...draft, defaultMode: event.target.value as PermissionMode })}>{(['deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}</select>
      <p className="field-hint">{t("operations.integrations.precedenceHint")}</p>
      <h3>{t("operations.integrations.operationGroups")}</h3>
      {draft.groups.map((group, index) => <div className="integration-group" key={group.id}><div><strong>{group.id}</strong><small>{'tag' in group.selector ? t('operations.integrations.exactTag', { tag: group.selector.tag }) : t('operations.integrations.operationList', { operations: group.selector.operationKeys.join(', ') })}</small></div><label><span className="sr-only">{t("operations.integrations.groupPermission")} {group.id}</span><select disabled={blocked} value={group.mode} onChange={event => setDraft({ ...draft, groups: draft.groups.map((item, at) => at === index ? { ...item, mode: event.target.value as RuleMode } : item) })}>{(['inherit', 'deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}</select></label><button type="button" disabled={blocked} onClick={() => setDraft({ ...draft, groups: draft.groups.filter(item => item.id !== group.id) })} aria-label={t('operations.integrations.removeGroup', { group: group.id })}>{t("operations.integrations.remove")}</button></div>)}
      {tags.length > 0 && <div className="integration-new-group"><label>{t("operations.integrations.newGroupKey")}<input value={newGroupId} onChange={event => setNewGroupId(event.target.value)} maxLength={64} disabled={blocked} /></label><label>{t("operations.integrations.exactGroupTag")}<select value={tag} onChange={event => setTag(event.target.value)} disabled={blocked}><option value="">{t("operations.integrations.selectTag")}</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label><button type="button" disabled={blocked || !tag || !/^[a-zA-Z0-9_.-]{1,64}$/.test(newGroupId) || draft.groups.some(group => group.id === newGroupId)} onClick={() => { setDraft({ ...draft, groups: [...draft.groups, { id: newGroupId, selector: { tag }, mode: 'ask' }] }); setNewGroupId(''); setTag('') }}>{t("operations.integrations.addGroupRule")}</button></div>}
      <div className="resource-toolbar"><h3>{t("operations.integrations.operationCatalog")}</h3><label className="search-field"><Icon name="search" /><input value={search} onChange={event => setSearch(event.target.value)} aria-label={t("operations.integrations.searchOperations")} placeholder={t("operations.integrations.searchPlaceholder")} /></label></div>
      <div className="integration-operations">{operations.map(operation => {
        const rule = draft.operations.find(item => item.operationKey === operation.operationKey)
        const reviewed = operation.reviewedOperationHash === operation.operationHash
        return <article className="integration-operation" key={operation.operationKey}><div className="page-heading"><div><h3>{operation.title}</h3><code>{operation.method} {operation.path}</code><p className="muted small">{t(effectLabel[operation.effect])} · {operation.tags.join(', ') || t("operations.integrations.noTags")}</p></div><Badge value={operation.enabled && reviewed ? 'ok' : 'draft'}>{!reviewed ? t("operations.integrations.reviewRequired") : operation.enabled ? t("operations.integrations.reviewedEnabled") : t("operations.integrations.reviewedDisabled")}</Badge></div><p>{operation.description}</p><label>{t("operations.integrations.operationPermission")} {operation.title}<select disabled={blocked} value={rule?.mode ?? 'inherit'} onChange={event => setOperationMode(operation.operationKey, event.target.value as RuleMode)}>{(['inherit', 'deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}</select></label>{(rule?.mode ?? 'inherit') !== 'inherit' && <button type="button" disabled={blocked} onClick={() => setOperationMode(operation.operationKey, 'inherit')}>{t("operations.integrations.resetInheritance")} {operation.title}</button>}<p className="integration-effective"><strong>{t("operations.integrations.savedDecision")}</strong> {decisionLabel(operation, t)}</p>{operation.effective.reasonCode === 'group_conflict_strictest' && <Notice>{t("operations.integrations.groupConflict")} {operation.effective.matchedRuleIds.join(', ')}{t("operations.integrations.strictestApplied")}</Notice>}<details><summary>{t("operations.integrations.exactDefinition")}</summary><pre>{JSON.stringify({ operationKey: operation.operationKey, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre></details><div className="integration-controls"><button type="button" disabled={blocked || isDirty || operation.effect === 'unknown'} onClick={() => setReviewing(operation)}>{t("operations.integrations.reviewEnable")} {operation.title}</button>{operation.enabled && <button type="button" disabled={blocked || isDirty} onClick={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: operation.operationKey, operationHash: operation.operationHash, enabled: false }] })}>{t("operations.integrations.disableOperation")} {operation.title}</button>}</div></article>
      })}{!operations.length && <Empty title={t("operations.integrations.noOperations")} />}</div>
      {isDirty && <Notice>{t("operations.integrations.unsavedRules")}</Notice>}
    </form>
    {reviewing && <ReviewOperation operation={reviewing} busy={busy} onClose={() => setReviewing(null)} onConfirm={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: reviewing.operationKey, operationHash: reviewing.operationHash, enabled: true }] })} />}
  </>
}

function ReviewOperation({ operation, busy, onClose, onConfirm }: { operation: CatalogOperation; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => opener?.focus() }, [])
  return <dialog ref={dialog} className="modal integration-review" onCancel={event => { event.preventDefault(); if (!busy) onClose() }} aria-labelledby="integration-review-title"><div className="modal-header"><h2 id="integration-review-title">{t("operations.integrations.reviewTitle")} {operation.title}</h2><button type="button" disabled={busy} aria-label={t("operations.integrations.closeReview")} onClick={onClose}><Icon name="close" /></button></div><p>{t("operations.integrations.reviewHint")}</p><pre>{JSON.stringify({ operationKey: operation.operationKey, effect: operation.effect, tags: operation.tags, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre><label className="integration-review-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("operations.integrations.reviewConfirmation")}</label><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>{t("operations.common.cancel")}</button><button className="primary" type="button" disabled={busy || !confirmed} onClick={onConfirm}>{busy ? t("operations.common.saving") : t("operations.integrations.confirmReview")}</button></div></dialog>
}
