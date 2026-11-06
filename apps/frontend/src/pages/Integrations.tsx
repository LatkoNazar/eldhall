import { WorkspaceProvider } from '../components/WorkspaceProvider'
import { useI18n, formatDateTime, type UiMessage } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { ApiError, request } from '../lib/api'
import { decisionLabel, inheritedMode, integrationPath, loadIntegration, loadIntegrations, modeLabel } from '../lib/integrations-api'
import type { CatalogOperation, IntegrationCatalog, IntegrationPolicy, IntegrationPolicyResponse, IntegrationSummary, PermissionGroup, PermissionMode, RuleMode } from '../lib/integrations-api'
import { registerNavigationGuard } from '../lib/navigation'
import { PermissionModeControl } from '../components/integrations/PermissionModeControl'
import { OperationRow } from '../components/integrations/OperationRow'
import { IntegrationImportWizard } from '../components/integrations/IntegrationImportWizard'
import type { ImportResult } from '../lib/integration-imports-api'

interface Draft { defaultMode: PermissionMode; groups: PermissionGroup[]; operations: { operationKey: string; mode: RuleMode }[] }
const toDraft = (policy: IntegrationPolicy, operations: CatalogOperation[]): Draft => ({ defaultMode: policy.defaultMode, groups: structuredClone(policy.groups), operations: operations.map(({ operationKey }) => ({ operationKey, mode: policy.operations.find(rule => rule.operationKey === operationKey)?.mode ?? 'inherit' })) })
const effectLabel = { read: "operations.integrations.readEffect", write: "operations.integrations.writeEffect", unknown: "operations.integrations.unknownEffect" } as const

export function Integrations({ token }: { token: string }) {
  const dirtyRef = useRef(false)
  return <WorkspaceProvider token={token}>{business => <div className="integrations-workspace">
    <IntegrationList key={business.id} businessId={business.id} token={token} dirtyRef={dirtyRef} />
  </div>}</WorkspaceProvider>
}

function IntegrationList({ businessId, token, dirtyRef }: { businessId: string; token: string; dirtyRef: { current: boolean } }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ data: IntegrationSummary[] | null; error: unknown | null }>({ data: null, error: null })
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('integrationId') ?? '')
  const [revision, setRevision] = useState(0)
  const [creating, setCreating] = useState(false)
  const connectButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    void loadIntegrations(businessId, token, controller.signal).then(data => { if (!controller.signal.aborted) setState({ data: data.integrations, error: null }) }).catch(cause => { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: cause })) })
    return () => controller.abort()
  }, [businessId, token, revision])
  const active = state.data?.find(item => item.integrationId === selected) ?? state.data?.[0]
  function connected(result: ImportResult) {
    setState(previous => ({ data: [...(previous.data ?? []).filter(item => item.integrationId !== result.integration.integrationId), result.integration], error: null }))
    setSelected(result.integration.integrationId); setCreating(false); setRevision(value => value + 1)
  }
  return <>
    <header className="integration-navigation">
      <h1>{t("operations.integrations.title")}</h1>
      {state.data?.length ? <label className="integration-picker"><span className="sr-only">{t('operations.integrations.integration')}</span><select disabled={creating} value={active?.integrationId ?? ''} onChange={event => { if (!dirtyRef.current || window.confirm(t('operations.integrations.discardPrompt'))) setSelected(event.target.value) }}>{state.data.map(item => <option key={item.integrationId} value={item.integrationId}>{item.integrationId} · {item.draining ? t('operations.integrations.draining') : item.enabled ? t('operations.integrations.active') : t('operations.integrations.disabled')}</option>)}</select></label> : <span />}
      <button ref={connectButton} className="primary" disabled={creating} onClick={() => { if (!dirtyRef.current || window.confirm(t('operations.integrations.discardPrompt'))) setCreating(true) }}><Icon name="plus" size={18} />{t('onboarding.new')}</button>
    </header>
    {Boolean(state.error) && <ErrorNotice error={state.error}><button onClick={() => setRevision(value => value + 1)}>{t('operations.integrations.refresh')}</button></ErrorNotice>}
    {creating ? <IntegrationImportWizard businessId={businessId} token={token} onConnected={connected} onCancel={() => { setCreating(false); connectButton.current?.focus() }} />
      : active ? <IntegrationEditor key={active.integrationId} id={active.integrationId} businessId={businessId} token={token} dirtyRef={dirtyRef} onChanged={() => setRevision(value => value + 1)} />
        : !state.error && <div className="card"><Empty icon="settings" title={state.data ? t('operations.integrations.noCatalogs') : t('operations.integrations.loading')}>{t('onboarding.description')}</Empty></div>}
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
  const [expanded, setExpanded] = useState<string | null>(null)
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
  const unavailable = data.catalog.unavailableOperations ?? []
  const save = () => void mutate('/policy', { defaultMode: draft.defaultMode, groups: draft.groups, operations: draft.operations }, 'PATCH')
  return <section className="integration-console" aria-label={id}>
    <header className="integration-summary">
      <div className="integration-summary-name"><h2 className="sr-only">{id}</h2><Badge value={integration.enabled ? 'ok' : 'draft'}>{integration.draining ? t('operations.integrations.finishingCalls') : integration.enabled ? t('operations.integrations.active') : t('operations.integrations.disabled')}</Badge>{data.catalog.source && <p className="small break-word integration-source-caption"><code>{data.catalog.source.upstreamBaseUrl}</code> · <a href={data.catalog.source.specUrl} target="_blank" rel="noopener noreferrer">OpenAPI</a></p>}</div>
      <div className="integration-primary-actions"><button className="primary" disabled={blocked || !isDirty} onClick={save}>{t('operations.integrations.saveRules')}</button><button disabled={blocked || isDirty || (integration.enabled && integration.activeManifestHash === integration.loadedManifestHash)} onClick={() => void mutate('/activate', { manifestHash: integration.loadedManifestHash, connectionRevision: integration.connectionRevision })}>{t('onboarding.checkActivate')}</button><button className="icon-button" aria-label={t('operations.integrations.reloadPolicy')} disabled={busy || loading} onClick={refresh}><Icon name="refresh" size={18} /></button></div>
    </header>
    {Boolean(error) && <ErrorNotice error={error}>{conflict && <p>{t('operations.integrations.versionConflict')}</p>}<button disabled={busy || loading} onClick={refresh}>{t('operations.integrations.reloadPolicy')}</button></ErrorNotice>}
    {notice && <Notice>{translateMessage(notice)}</Notice>}
    {isDirty && <Notice>{t('operations.integrations.unsavedRules')}</Notice>}
    <div className="integration-catalog-toolbar"><h3 className="sr-only">{t('operations.integrations.operationCatalog')}</h3><label className="search-field"><Icon name="search" size={18} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label={t('operations.integrations.searchOperations')} placeholder={t('operations.integrations.searchPlaceholder')} /></label><details className="integration-mode-help"><summary><Icon name="help" size={18} /><span className="sr-only">{t('onboarding.modeHint')}</span></summary><p className="muted">{t('operations.integrations.description')} {t('onboarding.modeHint')}</p></details></div>
    <div className="integration-tool-list" tabIndex={0} aria-label={t('operations.integrations.operationCatalog')}>
      <details className="integration-advanced-policy"><summary>{t('onboarding.advancedPolicy')}</summary>
        <PermissionModeControl value={draft.defaultMode} label={t('operations.integrations.defaultPermission')} disabled={blocked} onChange={mode => setDraft({ ...draft, defaultMode: mode })} />
        <p className="field-hint">{t('operations.integrations.precedenceHint')}</p>
        {draft.groups.map((group, index) => <div className="integration-group" key={group.id}><div><strong>{group.id}</strong><small>{'tag' in group.selector ? t('operations.integrations.exactTag', { tag: group.selector.tag }) : t('operations.integrations.operationList', { operations: group.selector.operationKeys.join(', ') })}</small></div><label><span className="sr-only">{t('operations.integrations.groupPermission')} {group.id}</span><select disabled={blocked} value={group.mode} onChange={event => setDraft({ ...draft, groups: draft.groups.map((item, at) => at === index ? { ...item, mode: event.target.value as RuleMode } : item) })}>{(['inherit', 'deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabel(mode, t)}</option>)}</select></label><button type="button" disabled={blocked} onClick={() => setDraft({ ...draft, groups: draft.groups.filter(item => item.id !== group.id) })} aria-label={t('operations.integrations.removeGroup', { group: group.id })}>{t('operations.integrations.remove')}</button></div>)}
        {tags.length > 0 && <div className="integration-new-group"><label>{t('operations.integrations.newGroupKey')}<input value={newGroupId} onChange={event => setNewGroupId(event.target.value)} maxLength={64} disabled={blocked} /></label><label>{t('operations.integrations.exactGroupTag')}<select value={tag} onChange={event => setTag(event.target.value)} disabled={blocked}><option value="">{t('operations.integrations.selectTag')}</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label><button type="button" disabled={blocked || !tag || !/^[a-zA-Z0-9_.-]{1,64}$/.test(newGroupId) || draft.groups.some(group => group.id === newGroupId)} onClick={() => { setDraft({ ...draft, groups: [...draft.groups, { id: newGroupId, selector: { tag }, mode: 'ask' }] }); setNewGroupId(''); setTag('') }}>{t('operations.integrations.addGroupRule')}</button></div>}
        <details><summary>{t('onboarding.technical')}</summary><p className="small muted">{t('operations.integrations.adminScope')}</p><dl className="facts"><dt>{t('operations.integrations.editVersion')}</dt><dd>{integration.version}</dd><dt>{t('operations.integrations.policyRevision')}</dt><dd>{integration.policyRevision}</dd><dt>{t('operations.integrations.connectionRevision')}</dt><dd>{integration.connectionRevision}</dd><dt>{t('operations.integrations.loadedManifest')}</dt><dd><code>{integration.loadedManifestHash}</code></dd><dt>{t('operations.integrations.activeManifest')}</dt><dd><code>{integration.activeManifestHash ?? t('operations.integrations.notActivated')}</code></dd><dt>{t('operations.common.updated')}</dt><dd>{formatDateTime(integration.updatedAt, locale)}</dd></dl></details>
        <div className="integration-controls"><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: false })}>{t('operations.integrations.disable')}</button><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: true })}>{t('operations.integrations.finishCalls')}</button></div>
      </details>
      {operations.map(operation => {
        const rule = draft.operations.find(item => item.operationKey === operation.operationKey)
        const reviewed = operation.reviewedOperationHash === operation.operationHash
        const changed = rule?.mode !== operation.mode
        return <OperationRow key={operation.operationKey} operationKey={operation.operationKey} method={operation.method} path={operation.path} title={operation.title} expanded={expanded === operation.operationKey} onToggle={() => setExpanded(expanded === operation.operationKey ? null : operation.operationKey)}
          status={<><Badge value={operation.enabled && reviewed ? 'ok' : 'draft'}>{!reviewed ? t('operations.integrations.reviewRequired') : operation.enabled ? t('operations.integrations.reviewedEnabled') : t('operations.integrations.reviewedDisabled')}</Badge><small>{decisionLabel(operation, t)}</small>{rule?.mode === 'inherit' && <small>{t('onboarding.inherited')}</small>}{changed && <small>{t('onboarding.draft')}</small>}</>}
          controls={<PermissionModeControl value={rule?.mode ?? 'inherit'} inherited={inheritedMode(operation, draft.groups, draft.defaultMode)} label={t('operations.integrations.operationPermission') + ' ' + operation.title} disabled={blocked} onChange={mode => setOperationMode(operation.operationKey, mode)} />}>
          <p>{operation.description}</p><p className="small muted">{t(effectLabel[operation.effect])} · {operation.tags.join(', ') || t('operations.integrations.noTags')}</p>
          {operation.effective.reasonCode === 'group_conflict_strictest' && <Notice>{t('operations.integrations.groupConflict')} {operation.effective.matchedRuleIds.join(', ')}{t('operations.integrations.strictestApplied')}</Notice>}
          <div className="integration-controls"><button type="button" disabled={blocked || isDirty || operation.effect === 'unknown'} onClick={() => setReviewing(operation)}>{t('operations.integrations.reviewEnable')} {operation.title}</button>{operation.enabled && <button type="button" disabled={blocked || isDirty} onClick={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: operation.operationKey, operationHash: operation.operationHash, enabled: false }] })}>{t('operations.integrations.disableOperation')} {operation.title}</button>}</div>
          <details><summary>{t('operations.integrations.exactDefinition')}</summary><pre>{JSON.stringify({ operationKey: operation.operationKey, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre>
            <button type="button" disabled={blocked || rule?.mode === 'inherit'} onClick={() => setOperationMode(operation.operationKey, 'inherit')}>{t('operations.integrations.resetInheritance')} {operation.title}</button>
          </details>
        </OperationRow>
      })}
      {unavailable.filter(operation => `${operation.title} ${operation.operationKey}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale))).map(operation => <OperationRow key={operation.operationKey} operationKey={operation.operationKey} method={operation.method} path={operation.path} title={operation.title} expanded={expanded === operation.operationKey} onToggle={() => setExpanded(expanded === operation.operationKey ? null : operation.operationKey)} status={<Badge value="denied">{t('onboarding.blocked')}</Badge>} controls={<PermissionModeControl value="deny" label={t('onboarding.modeFor', { operation: operation.title })} disabled onChange={() => undefined} />}><Notice>{operation.supported ? t('onboarding.reviewRequired') : t('onboarding.unsupported')}</Notice>{operation.reasonCode && <p className="small">{t('onboarding.reason')}: <code>{operation.reasonCode}</code></p>}</OperationRow>)}
      {!operations.length && !unavailable.length && <Empty title={t('operations.integrations.noOperations')} />}
    </div>
    {reviewing && <ReviewOperation operation={reviewing} busy={busy} onClose={() => setReviewing(null)} onConfirm={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: reviewing.operationKey, operationHash: reviewing.operationHash, enabled: true }] })} />}
  </section>
}

function ReviewOperation({ operation, busy, onClose, onConfirm }: { operation: CatalogOperation; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => opener?.focus() }, [])
  return <dialog ref={dialog} className="modal integration-review" onCancel={event => { event.preventDefault(); if (!busy) onClose() }} aria-labelledby="integration-review-title"><div className="modal-header"><h2 id="integration-review-title">{t("operations.integrations.reviewTitle")} {operation.title}</h2><button type="button" disabled={busy} aria-label={t("operations.integrations.closeReview")} onClick={onClose}><Icon name="close" /></button></div><p>{t("operations.integrations.reviewHint")}</p><dl className="facts"><dt>{t('onboarding.effect')}</dt><dd>{t(effectLabel[operation.effect])}</dd><dt>{t('onboarding.customerScope')}</dt><dd><code>{JSON.stringify(operation.scope)}</code></dd><dt>{t('onboarding.outputs')}</dt><dd>{operation.outputFields?.join(', ')}</dd></dl><details><summary>{t('onboarding.technical')}</summary><pre>{JSON.stringify({ operationKey: operation.operationKey, effect: operation.effect, tags: operation.tags, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre></details><label className="integration-review-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("operations.integrations.reviewConfirmation")}</label><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>{t("operations.common.cancel")}</button><button className="primary" type="button" disabled={busy || !confirmed} onClick={onConfirm}>{busy ? t("operations.common.saving") : t("operations.integrations.confirmReview")}</button></div></dialog>
}
