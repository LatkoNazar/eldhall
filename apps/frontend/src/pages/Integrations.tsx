import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { ApiError, dateTime, errorText, request } from '../lib/api'
import { decisionLabel, integrationPath, loadIntegration, loadIntegrations, modeLabels } from '../lib/integrations-api'
import type { CatalogOperation, IntegrationCatalog, IntegrationPolicy, IntegrationPolicyResponse, IntegrationSummary, PermissionGroup, PermissionMode, RuleMode } from '../lib/integrations-api'
import { registerNavigationGuard } from '../lib/navigation'
import { useResource } from '../lib/useResource'

interface Draft { defaultMode: PermissionMode; groups: PermissionGroup[]; operations: { operationKey: string; mode: RuleMode }[] }
const toDraft = (policy: IntegrationPolicy, operations: CatalogOperation[]): Draft => ({ defaultMode: policy.defaultMode, groups: structuredClone(policy.groups), operations: operations.map(({ operationKey }) => ({ operationKey, mode: policy.operations.find(rule => rule.operationKey === operationKey)?.mode ?? 'inherit' })) })
const effectLabel = { read: 'Читання', write: 'Зміна даних', unknown: 'Тип потребує review' }

export function Integrations({ token }: { token: string }) {
  const businesses = useResource<{ businesses: { id: string; name: string; currency: string }[] }>('/businesses', token)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('businessId') ?? '')
  const business = businesses.data?.businesses.find(item => item.id === selected) ?? businesses.data?.businesses[0]
  const dirtyRef = useRef(false)
  return <>
    <div className="page-heading"><div><h1>Інтеграції</h1><p>Переглянуті операції, дозволи й активна версія каталогу.</p></div></div>
    <p className="muted small">Ключ оператора надає адміністративний доступ до всього розгортання.</p>
    {businesses.error && <Notice error>{businesses.error} <button onClick={businesses.refresh}>Оновити бізнеси</button></Notice>}
    {business ? <><div className="business-scope"><label htmlFor="integrations-business">Бізнес інтеграцій</label><select id="integrations-business" value={business.id} onChange={event => { if (!dirtyRef.current || window.confirm('Відкинути незбережені правила інтеграції?')) setSelected(event.target.value) }}>{businesses.data?.businesses.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></div><IntegrationList key={business.id} businessId={business.id} token={token} dirtyRef={dirtyRef} /></> : <div className="card"><Empty title={businesses.loading ? 'Завантажуємо бізнеси…' : 'Немає доступного бізнесу'} /></div>}
  </>
}

function IntegrationList({ businessId, token, dirtyRef }: { businessId: string; token: string; dirtyRef: { current: boolean } }) {
  const [state, setState] = useState<{ data: IntegrationSummary[] | null; error: string }>({ data: null, error: '' })
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('integrationId') ?? '')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadIntegrations(businessId, token, controller.signal).then(data => { if (!controller.signal.aborted) setState({ data: data.integrations, error: '' }) }).catch(cause => { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: errorText(cause) })) })
    return () => controller.abort()
  }, [businessId, token, revision])
  const active = state.data?.find(item => item.integrationId === selected) ?? state.data?.[0]
  return <>
    {state.error && <Notice error>{state.error} <button onClick={() => setRevision(value => value + 1)}>Оновити інтеграції</button></Notice>}
    {state.data?.length ? <><div className="integration-picker"><label htmlFor="integration-select">Інтеграція</label><select id="integration-select" value={active?.integrationId ?? ''} onChange={event => { if (!dirtyRef.current || window.confirm('Відкинути незбережені правила інтеграції?')) setSelected(event.target.value) }}>{state.data.map(item => <option key={item.integrationId} value={item.integrationId}>{item.integrationId} · {item.draining ? 'Завершення викликів' : item.enabled ? 'Активна' : 'Вимкнена'}</option>)}</select></div>{active && <IntegrationEditor key={active.integrationId} id={active.integrationId} businessId={businessId} token={token} dirtyRef={dirtyRef} onChanged={() => setRevision(value => value + 1)} />}</> : !state.error && <div className="card"><Empty icon="settings" title={state.data ? 'Каталогів інтеграцій немає' : 'Завантажуємо інтеграції…'}>Каталог додається під час deployment: імпортуйте OpenAPI, змонтуйте manifest і налаштуйте connector.</Empty></div>}
  </>
}

function IntegrationEditor({ id, businessId, token, dirtyRef, onChanged }: { id: string; businessId: string; token: string; dirtyRef: { current: boolean }; onChanged: () => void }) {
  const [data, setData] = useState<{ catalog: IntegrationCatalog; policy: IntegrationPolicyResponse } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState<CatalogOperation | null>(null)
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [newGroupId, setNewGroupId] = useState('')
  const load = useCallback((signal?: AbortSignal) => loadIntegration(id, businessId, token, signal)
    .then(result => {
      if (!signal?.aborted) { setData(result); setDraft(toDraft(result.policy.policy, result.catalog.operations)); setConflict(false); setError('') }
      return true
    })
    .catch(cause => { if (!signal?.aborted) { setError(errorText(cause)); if (cause instanceof ApiError && cause.status === 409) setConflict(true) }; return false })
    .finally(() => { if (!signal?.aborted) setLoading(false) }), [id, businessId, token])
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])
  const isDirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(data.policy.policy, data.catalog.operations))
  useEffect(() => {
    dirtyRef.current = isDirty
    const remove = registerNavigationGuard(() => !isDirty || window.confirm('Відкинути незбережені правила інтеграції?'))
    const beforeUnload = (event: BeforeUnloadEvent) => { if (isDirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { remove(); dirtyRef.current = false; window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirtyRef, isDirty])
  const blocked = loading || busy || !!error || conflict
  function setOperationMode(operationKey: string, mode: RuleMode) {
    setDraft(current => current ? { ...current, operations: current.operations.map(rule => rule.operationKey === operationKey ? { ...rule, mode } : rule) } : current)
  }
  async function mutate(suffix: string, body: Record<string, unknown>, method = 'POST') {
    if (!data || blocked) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request(integrationPath(id, businessId, suffix), token, { method, body: { ...body, version: data.policy.integration.version } })
      setLoading(true); const reloaded = await load()
      setReviewing(null)
      onChanged()
      setNotice(reloaded ? 'Сервер зберіг зміни. Ефективні дозволи перечитано.' : 'Сервер зберіг зміни. Поточний стан ще не вдалося перечитати.')
    } catch (cause) {
      setError(errorText(cause))
      setReviewing(null)
      if (cause instanceof ApiError && cause.status === 409) setConflict(true)
    } finally { setBusy(false) }
  }
  function refresh() { if (!isDirty || window.confirm('Перечитати поточну політику й відкинути незбережені зміни?')) { setReviewing(null); setLoading(true); void load() } }
  if (!data || !draft) return <>{error && <Notice error>{error} <button onClick={refresh}>Перечитати поточну політику</button></Notice>}<div className="card"><Empty title={loading ? 'Завантажуємо каталог і політику…' : 'Каталог недоступний'} /></div></>
  const integration = data.policy.integration
  const operations = data.catalog.operations.filter(operation => `${operation.title} ${operation.operationKey} ${operation.tags.join(' ')}`.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA')))
  const tags = [...new Set(data.catalog.operations.flatMap(operation => operation.tags))].sort()
  return <>
    <section className="card padded integration-summary">
      <div className="page-heading"><div><h2>{id}</h2><Badge value={integration.enabled ? 'ok' : 'draft'}>{integration.draining ? 'Завершення поточних викликів' : integration.enabled ? 'Активна' : 'Вимкнена'}</Badge></div><button disabled={busy || loading} onClick={refresh}><Icon name="refresh" />Перечитати поточну політику</button></div>
      <dl className="facts"><dt>Версія редагування</dt><dd>{integration.version}</dd><dt>Ревізія політики</dt><dd>{integration.policyRevision}</dd><dt>Ревізія підключення</dt><dd className="break-word">{integration.connectionRevision}</dd><dt>Завантажений маніфест</dt><dd className="break-word"><code>{integration.loadedManifestHash}</code></dd><dt>Активний маніфест</dt><dd className="break-word"><code>{integration.activeManifestHash ?? 'Не активовано'}</code></dd><dt>Оновлено</dt><dd>{dateTime(integration.updatedAt)}</dd></dl>
      <div className="integration-controls"><button disabled={blocked || isDirty || (integration.enabled && integration.activeManifestHash === integration.loadedManifestHash)} onClick={() => void mutate('/activate', { manifestHash: integration.loadedManifestHash, connectionRevision: integration.connectionRevision })}>Активувати каталог після перевірки</button><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: false })}>Вимкнути інтеграцію</button><button disabled={blocked || isDirty || !integration.enabled} onClick={() => void mutate('/disable', { draining: true })}>Завершити поточні виклики</button></div>
      <p className="field-hint">Активація перевіряє готовність connector і точний manifest. Вона не погоджує визначення нових операцій. Вимкнення зупиняє нові виклики та скасовує невиконані погодження.</p>
    </section>
    {error && <Notice error>{conflict ? `Конфлікт версій. Ваші зміни не записані. ${error}` : error} <button disabled={busy || loading} onClick={refresh}>Перечитати поточну політику</button></Notice>}
    {notice && <Notice>{notice}</Notice>}
    <form className="card padded integration-policy" onSubmit={event => { event.preventDefault(); void mutate('/policy', { defaultMode: draft.defaultMode, groups: draft.groups, operations: draft.operations }, 'PATCH') }}>
      <div className="page-heading"><div><h2>Правила виконання</h2><p>Зміна дозволу не вмикає операцію й не погоджує її визначення.</p></div><button className="primary" type="submit" disabled={blocked || !isDirty}>Зберегти правила</button></div>
      <label htmlFor="integration-default-mode">Типовий дозвіл інтеграції</label><select id="integration-default-mode" disabled={blocked} value={draft.defaultMode} onChange={event => setDraft({ ...draft, defaultMode: event.target.value as PermissionMode })}>{(['deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select>
      <p className="field-hint">Власне правило операції має пріоритет. Якщо операція успадковує кілька груп, діє найсуворіше: Deny → Ask → Auto. Обов’язкові серверні перевірки діють у кожному режимі.</p>
      <h3>Групи операцій</h3>
      {draft.groups.map((group, index) => <div className="integration-group" key={group.id}><div><strong>{group.id}</strong><small>{'tag' in group.selector ? `Точний тег: ${group.selector.tag}` : `Операції: ${group.selector.operationKeys.join(', ')}`}</small></div><label><span className="sr-only">Дозвіл групи {group.id}</span><select disabled={blocked} value={group.mode} onChange={event => setDraft({ ...draft, groups: draft.groups.map((item, at) => at === index ? { ...item, mode: event.target.value as RuleMode } : item) })}>{(['inherit', 'deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select></label><button type="button" disabled={blocked} onClick={() => setDraft({ ...draft, groups: draft.groups.filter(item => item.id !== group.id) })} aria-label={`Прибрати правило групи ${group.id}`}>Прибрати</button></div>)}
      {tags.length > 0 && <div className="integration-new-group"><label>Ключ нової групи<input value={newGroupId} onChange={event => setNewGroupId(event.target.value)} maxLength={64} disabled={blocked} /></label><label>Точний тег групи<select value={tag} onChange={event => setTag(event.target.value)} disabled={blocked}><option value="">Оберіть тег</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label><button type="button" disabled={blocked || !tag || !/^[a-zA-Z0-9_.-]{1,64}$/.test(newGroupId) || draft.groups.some(group => group.id === newGroupId)} onClick={() => { setDraft({ ...draft, groups: [...draft.groups, { id: newGroupId, selector: { tag }, mode: 'ask' }] }); setNewGroupId(''); setTag('') }}>Додати групове правило</button></div>}
      <div className="resource-toolbar"><h3>Каталог операцій</h3><label className="search-field"><Icon name="search" /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Пошук операцій" placeholder="Назва, шлях або тег…" /></label></div>
      <div className="integration-operations">{operations.map(operation => {
        const rule = draft.operations.find(item => item.operationKey === operation.operationKey)
        const reviewed = operation.reviewedOperationHash === operation.operationHash
        return <article className="integration-operation" key={operation.operationKey}><div className="page-heading"><div><h3>{operation.title}</h3><code>{operation.method} {operation.path}</code><p className="muted small">{effectLabel[operation.effect]} · {operation.tags.join(', ') || 'Без тегів'}</p></div><Badge value={operation.enabled && reviewed ? 'ok' : 'draft'}>{!reviewed ? 'Потрібен review поточної версії' : operation.enabled ? 'Переглянуто й увімкнено' : 'Переглянуто, вимкнено'}</Badge></div><p>{operation.description}</p><label>Дозвіл операції {operation.title}<select disabled={blocked} value={rule?.mode ?? 'inherit'} onChange={event => setOperationMode(operation.operationKey, event.target.value as RuleMode)}>{(['inherit', 'deny', 'ask', 'auto'] as const).map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select></label>{(rule?.mode ?? 'inherit') !== 'inherit' && <button type="button" disabled={blocked} onClick={() => setOperationMode(operation.operationKey, 'inherit')}>Скинути до успадкування {operation.title}</button>}<p className="integration-effective"><strong>Збережене рішення:</strong> {decisionLabel(operation)}</p>{operation.effective.reasonCode === 'group_conflict_strictest' && <Notice>Конфлікт груп: {operation.effective.matchedRuleIds.join(', ')}. Сервер застосував найсуворіший дозвіл.</Notice>}<details><summary>Визначення й точний відбиток операції</summary><pre>{JSON.stringify({ operationKey: operation.operationKey, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre></details><div className="integration-controls"><button type="button" disabled={blocked || isDirty || operation.effect === 'unknown'} onClick={() => setReviewing(operation)}>Переглянути й увімкнути {operation.title}</button>{operation.enabled && <button type="button" disabled={blocked || isDirty} onClick={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: operation.operationKey, operationHash: operation.operationHash, enabled: false }] })}>Вимкнути операцію {operation.title}</button>}</div></article>
      })}{!operations.length && <Empty title="Операцій за цим запитом немає" />}</div>
      {isDirty && <Notice>Є незбережені правила. Перед review або активацією збережіть їх чи перечитайте поточну політику.</Notice>}
    </form>
    {reviewing && <ReviewOperation operation={reviewing} busy={busy} onClose={() => setReviewing(null)} onConfirm={() => void mutate('/review', { manifestHash: integration.loadedManifestHash, operations: [{ operationKey: reviewing.operationKey, operationHash: reviewing.operationHash, enabled: true }] })} />}
  </>
}

function ReviewOperation({ operation, busy, onClose, onConfirm }: { operation: CatalogOperation; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => opener?.focus() }, [])
  return <dialog ref={dialog} className="modal integration-review" onCancel={event => { event.preventDefault(); if (!busy) onClose() }} aria-labelledby="integration-review-title"><div className="modal-header"><h2 id="integration-review-title">Перегляд: {operation.title}</h2><button type="button" disabled={busy} aria-label="Закрити перегляд операції" onClick={onClose}><Icon name="close" /></button></div><p>Погоджується саме це визначення. Режим Auto / Ask / Deny зберігається окремо.</p><pre>{JSON.stringify({ operationKey: operation.operationKey, effect: operation.effect, tags: operation.tags, operationHash: operation.operationHash, inputSchema: operation.inputSchema, parameters: operation.parameters, scope: operation.scope, outputFields: operation.outputFields, guard: operation.guard, idempotency: operation.idempotency, reconciliation: operation.reconciliation }, null, 2)}</pre><label className="integration-review-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Я перевірив(ла) визначення та точний відбиток цієї операції</label><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Скасувати</button><button className="primary" type="button" disabled={busy || !confirmed} onClick={onConfirm}>{busy ? 'Зберігаємо…' : 'Підтвердити review і ввімкнути'}</button></div></dialog>
}
