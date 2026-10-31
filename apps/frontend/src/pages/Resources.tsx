import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Avatar, Badge, Empty, Icon, Metric, Notice } from '../components/ui'
import { dateTime, errorText, request, toolLabels } from '../lib/api'
import type { ClassificationConfig } from '../lib/api'
import { useResource } from '../lib/useResource'
import { registerNavigationGuard } from '../lib/navigation'
import { KnowledgeSearchTest } from '../components/KnowledgeSearchTest'
import { AccessFields, KnowledgeImport } from '../components/KnowledgeImport'
import { KnowledgeVersions } from '../components/KnowledgeVersions'
import { parsePlans } from '../lib/knowledge'

interface Business { id: string; name: string; currency: string; slug: string }
interface Source { id: string; businessId: string; title: string; category: string; content: string; version: number; status: 'draft' | 'published' | 'revoked'; updatedAt: string; audience?: 'customer' | 'internal'; plans?: string[]; sourceUrl?: string | null }
interface KnowledgeData { sources: Source[]; capabilities: { create: boolean; update: boolean; publish: boolean; revoke: boolean } }
interface SettingsData { businessId: string; version: number; language: string; tone: string; requireApproval: boolean; refundLimitCents: number; duplicateWindowMinutes: number; enabledTools: string[]; classification?: ClassificationConfig | null }
interface Member { id: string; name: string; role: string; assignedCases: number }
const DirtyScope = createContext<{ current: boolean } | null>(null)

function Scope({ token, children }: { token: string; children: (business: Business) => ReactNode }) {
  const resource = useResource<{ businesses: Business[] }>('/businesses', token)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('businessId') ?? '')
  const dirty = useRef(false)
  const businesses = resource.data?.businesses ?? []
  const business = businesses.find(item => item.id === selected) ?? businesses[0]
  return <>{resource.error && <Notice error>{resource.error} <button onClick={resource.refresh}>Оновити</button></Notice>}{business ? <><div className="business-scope"><label htmlFor="business-scope">Бізнес</label><select id="business-scope" value={business.id} onChange={event => { if (allowDiscard(dirty.current)) setSelected(event.target.value) }}>{businesses.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select><span className="muted small">Дані та правила окремі для кожного бізнесу</span></div><DirtyScope.Provider value={dirty}><div key={business.id}>{children(business)}</div></DirtyScope.Provider></> : <div className="card"><Empty title={resource.loading ? 'Завантажуємо бізнеси…' : 'Немає доступного бізнесу'} /></div>}</>
}

export function Knowledge({ token }: { token: string }) { return <Scope token={token}>{business => <KnowledgePanel token={token} business={business} />}</Scope> }

function KnowledgePanel({ token, business }: { token: string; business: Business }) {
  const resource = useResource<KnowledgeData>(`/knowledge?businessId=${business.id}`, token)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('documentId') ?? '')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')
  const sources = resource.data?.sources ?? []
  const visible = sources.filter(source => (!category || source.category === category) && `${source.title} ${source.content}`.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA')))
  const active = sources.find(source => source.id === selected) ?? sources[0]
  const dirty = useContext(DirtyScope)
  return <>
    <div className="page-heading"><div><h1>База знань</h1><p>Перевірені джерела для відповідей вашого AI-помічника.</p></div><button className="primary" disabled={!resource.data?.capabilities.create} onClick={() => setCreating(true)}><Icon name="plus" />Додати документ</button></div>
    {resource.error && <Notice error>{resource.error} <button onClick={resource.refresh}>Оновити</button></Notice>}{notice && <Notice>{notice}</Notice>}
    <div className="knowledge-layout">
      <section className="card knowledge-list"><div className="resource-toolbar"><label className="search-field"><Icon name="search" /><input aria-label="Пошук у базі знань" placeholder="Пошук у базі знань…" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="Категорія документів" value={category} onChange={event => setCategory(event.target.value)}><option value="">Усі категорії</option>{Array.from(new Set(sources.map(source => source.category))).map(value => <option key={value}>{value}</option>)}</select></div>
        {visible.length ? <div className="table-scroll"><table><caption className="sr-only">Документи бази знань бізнесу {business.name}</caption><thead><tr><th>Документ</th><th>Версія</th><th>Статус</th></tr></thead><tbody>{visible.map(source => <tr key={source.id} className={source.id === active?.id ? 'selected-row' : ''}><td><button className="document-link" onClick={() => { if (allowDiscard(dirty?.current ?? false)) setSelected(source.id) }} aria-pressed={source.id === active?.id}><Icon name="file" /><span><strong>{source.title}</strong><small>{source.category}</small></span></button></td><td>v{source.version}</td><td><Badge value={source.status} /></td></tr>)}</tbody></table></div> : <Empty icon="book" title={resource.loading ? 'Завантажуємо документи…' : sources.length ? 'За цим запитом нічого немає' : 'Знання починаються з джерела'}>{sources.length ? 'Змініть пошук або категорію.' : 'Додайте документ, перевірте текст і опублікуйте його.'}</Empty>}
      </section>
      {active && resource.data ? <SourceEditor key={`${active.id}-${active.version}`} source={active} capabilities={resource.data.capabilities} token={token} onSaved={message => { setNotice(message); resource.refresh() }} /> : <section className="card"><Empty icon="file" title="Оберіть документ">Текст, статус і версія джерела з’являться тут.</Empty></section>}
    </div>
    <Notice>Лише опубліковані та доступні джерела можуть використовуватися для відповідей. Текст документа не надає дозволів на бізнес-дії.</Notice>
    <div className="two-columns"><KnowledgeSearchTest key={`search-${business.id}`} token={token} businessId={business.id} /><KnowledgeImport key={`import-${business.id}`} token={token} businessId={business.id} onImported={message => { setNotice(message); resource.refresh() }} /></div>
    {creating && <CreateSource token={token} businessId={business.id} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setNotice('Документ створено як чернетку.'); resource.refresh() }} />}
  </>
}

function SourceEditor({ source, capabilities, token, onSaved }: { source: Source; capabilities: KnowledgeData['capabilities']; token: string; onSaved: (message: string) => void }) {
  const [title, setTitle] = useState(source.title)
  const [category, setCategory] = useState(source.category)
  const [content, setContent] = useState(source.content)
  const [audience, setAudience] = useState<'customer' | 'internal'>(source.audience ?? 'customer')
  const [plans, setPlans] = useState((source.plans ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = title !== source.title || category !== source.category || content !== source.content || audience !== (source.audience ?? 'customer') || parsePlans(plans).join('|') !== (source.plans ?? []).join('|')
  useUnsaved(dirty)
  if (source.status === 'revoked') return <section className="card padded"><h2>{source.title}</h2><Badge value="revoked" /><Notice>Доступ до джерела відкликано. Попередній вміст більше не відображається та не використовується для нових відповідей.</Notice><small className="muted">v{source.version} · {dateTime(source.updatedAt)}</small></section>
  async function save(action: 'save' | 'publish' | 'revoke') {
    setBusy(true); setError('')
    try {
      if (action === 'save') await request(`/knowledge/${source.id}?businessId=${source.businessId}`, token, { method: 'PATCH', body: { version: source.version, title: title.trim(), category: category.trim(), content: content.trim(), audience, plans: parsePlans(plans) } })
      else await request(`/knowledge/${source.id}/${action}?businessId=${source.businessId}`, token, { method: 'POST', body: { version: source.version } })
      onSaved(action === 'save' ? 'Зміни збережено. Перевірте статус джерела перед публікацією.' : action === 'publish' ? 'Документ опубліковано.' : 'Доступ до джерела відкликано.')
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }
  return <section className="card source-detail padded"><div className="source-heading"><span className="source-file-icon"><Icon name="file" size={28} /></span><div><h2>{source.title}</h2><div className="inline-meta"><span>{source.category}</span><span>v{source.version}</span><Badge value={source.status} />{source.audience === 'internal' && <Badge>Лише команда</Badge>}{source.plans?.length ? <span>Тарифи: {source.plans.join(', ')}</span> : null}{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">джерело</a>}</div></div></div>
    <form onSubmit={event => { event.preventDefault(); void save('save') }}><label htmlFor="source-title">Назва</label><input id="source-title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} disabled={!capabilities.update || busy} /><label htmlFor="source-category">Категорія</label><input id="source-category" required maxLength={80} value={category} onChange={event => setCategory(event.target.value)} disabled={!capabilities.update || busy} /><AccessFields idPrefix="source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={!capabilities.update || busy} /><label htmlFor="source-content">Вміст</label><textarea id="source-content" className="source-content" required maxLength={30000} value={content} onChange={event => setContent(event.target.value)} disabled={!capabilities.update || busy} /><p className="field-hint">Оновлено {dateTime(source.updatedAt)} (Київ). Збереження та публікація — окремі дії.</p>{error && <Notice error>{error}</Notice>}<div className="form-actions"><button type="submit" disabled={!dirty || busy || !capabilities.update}>Зберегти чернетку</button>{source.status !== 'published' && <button className="primary" type="button" disabled={busy || dirty || !capabilities.publish} onClick={() => void save('publish')}><Icon name="check" size={17} />Опублікувати</button>}{source.status === 'published' && <button className="outline-danger" type="button" disabled={busy || dirty || !capabilities.revoke} onClick={() => void save('revoke')}>Відкликати доступ</button>}</div>{dirty && <p className="field-hint">Є незбережені зміни. Спочатку збережіть їх.</p>}</form>
    <KnowledgeVersions token={token} businessId={source.businessId} sourceId={source.id} current={source.version} />
  </section>
}

function CreateSource({ token, businessId, onClose, onCreated }: { token: string; businessId: string; onClose: () => void; onCreated: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer')
  const [plans, setPlans] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close() }, [])
  return <dialog ref={dialog} className="modal" onCancel={event => { if (busy) event.preventDefault(); else onClose() }} aria-labelledby="create-source-title"><div className="modal-header"><h2 id="create-source-title">Новий документ</h2><button className="icon-button" disabled={busy} aria-label="Закрити" onClick={onClose}><Icon name="close" /></button></div><form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError(''); void request(`/knowledge?businessId=${businessId}`, token, { method: 'POST', body: { title: String(fields.get('title')).trim(), category: String(fields.get('category')).trim(), content: String(fields.get('content')).trim(), audience, plans: parsePlans(plans) } }).then(onCreated).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)) }}><label htmlFor="new-source-title">Назва документа</label><input id="new-source-title" name="title" required maxLength={160} /><label htmlFor="new-source-category">Категорія</label><input id="new-source-category" name="category" required maxLength={80} placeholder="Наприклад, Оплата" /><AccessFields idPrefix="new-source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={busy} /><label htmlFor="new-source-content">Вміст</label><textarea id="new-source-content" name="content" required maxLength={30000} rows={9} /><p className="field-hint">Документ буде створено як чернетку, без автоматичної публікації.</p>{error && <Notice error>{error}</Notice>}<div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Скасувати</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Створюємо…' : 'Створити чернетку'}</button></div></form></dialog>
}

export function Team({ token }: { token: string }) {
  const resource = useResource<{ members: Member[]; capabilities: { invite: boolean; updateRole: boolean } }>('/team', token, 10000)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const members = resource.data?.members ?? []
  const visible = members.filter(member => member.name.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA')))
  const active = members.find(member => member.id === selected) ?? members[0]
  return <>
    <div className="page-heading"><div><h1>Команда</h1><p>Відповідальні оператори та поточне навантаження.</p></div><span className="period-label"><Icon name="lock" size={17} />Доступ керується сервером</span></div>
    {resource.error && <Notice error>{resource.error} <button onClick={resource.refresh}>Оновити</button></Notice>}
    <div className="metrics-grid team-metrics"><Metric icon="team" label="Операторів" value={resource.data ? members.length : '—'} /><Metric icon="inbox" label="Призначених звернень" value={resource.data ? members.reduce((sum, member) => sum + member.assignedCases, 0) : '—'} /><Metric icon="lock" label="Режим доступу" value="Службовий" hint="Ідентичність перевіряє сервер" /></div>
    <div className="two-columns team-layout"><section className="card"><div className="resource-toolbar"><h2>Оператори</h2><label className="search-field"><Icon name="search" /><input aria-label="Пошук операторів" value={search} onChange={event => setSearch(event.target.value)} placeholder="Пошук за ім’ям…" /></label></div>{visible.length ? <div className="table-scroll"><table><thead><tr><th>Ім’я</th><th>Роль</th><th>Звернень</th></tr></thead><tbody>{visible.map(member => <tr key={member.id} className={member.id === active?.id ? 'selected-row' : ''}><td><button className="document-link" onClick={() => setSelected(member.id)}><Avatar name={member.name} seed={`operator:${member.id}`} /><strong>{member.name}</strong></button></td><td>{roleLabel(member.role)}</td><td>{member.assignedCases}</td></tr>)}</tbody></table></div> : <Empty icon="team" title={resource.loading ? 'Завантажуємо команду…' : 'Операторів не знайдено'} />}</section><section className="card padded">{active ? <><div className="customer-heading"><Avatar name={active.name} seed={`operator:${active.id}`} /><div><h2>{active.name}</h2><Badge>{roleLabel(active.role)}</Badge></div></div><div className="section-divider" /><h3>Навантаження</h3><p className="large-number">{active.assignedCases}</p><p className="muted">Звернень, призначених цьому оператору.</p><div className="section-divider" /><h3>Доступ</h3><p>Відповіді клієнтам, перегляд дій AI, погодження та виконання перевіряються сервером у кожному запиті.</p><Notice>Запрошення та редагування ролей у цьому середовищі не підключені. Активність у мережі не відстежується.</Notice></> : <Empty icon="team" title="Оберіть оператора" />}</section></div>
  </>
}

export function Settings({ token }: { token: string }) { return <Scope token={token}>{business => <SettingsPanel token={token} business={business} />}</Scope> }

function SettingsPanel({ token, business }: { token: string; business: Business }) {
  const resource = useResource<SettingsData>(`/settings?businessId=${business.id}`, token)
  const [notice, setNotice] = useState('')
  return <><div className="page-heading"><div><h1>Налаштування</h1><p>Мова помічника, дозволені інструменти та правила погодження.</p></div>{resource.data && <Badge>Версія {resource.data.version}</Badge>}</div>{notice && <Notice>{notice}</Notice>}{resource.error && <Notice error>{resource.error} <button onClick={resource.refresh}>Оновити</button></Notice>}{resource.data ? <><SettingsEditor key={resource.data.version} settings={resource.data} business={business} token={token} onSaved={() => { setNotice('Налаштування збережено сервером. Нові запуски використовуватимуть актуальні правила.'); resource.refresh() }} /><section className="card padded"><h2>Класифікація тікетів</h2>{resource.data.classification ? <><p className="muted">Конфігурація бізнесу · версія {resource.data.classification.revision}. Класи змінюються у файлі інтеграції або через API налаштувань.</p><p>Поріг оцінки моделі: {new Intl.NumberFormat('uk-UA', { style: 'percent', maximumFractionDigits: 0 }).format(resource.data.classification.minimumConfidence)}. Нижче порога — резервний клас і перевірка оператором.</p><ul>{resource.data.classification.classes.map(item => <li key={item.id}><strong className="break-word">{item.label}</strong> <small className="muted">ID {item.id}{item.id === resource.data?.classification?.fallbackClassId ? ' · резервний клас' : ''}</small><p className="small">{item.description}</p></li>)}</ul></> : <p className="muted">Класи не налаштовані. Додайте classifications до файлу інтеграції бізнесу.</p>}</section><Skills token={token} business={business} /></> : <div className="card"><Empty icon="settings" title={resource.loading ? 'Завантажуємо налаштування…' : 'Налаштування недоступні'} /></div>}</>
}

function SettingsEditor({ settings, business, token, onSaved }: { settings: SettingsData; business: Business; token: string; onSaved: () => void }) {
  const [language, setLanguage] = useState(settings.language)
  const [tone, setTone] = useState(settings.tone)
  const [limit, setLimit] = useState(String(settings.refundLimitCents / 100))
  const [windowMinutes, setWindowMinutes] = useState(String(settings.duplicateWindowMinutes))
  const [tools, setTools] = useState(settings.enabledTools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = language !== settings.language || tone !== settings.tone || Number(limit) * 100 !== settings.refundLimitCents || Number(windowMinutes) !== settings.duplicateWindowMinutes || JSON.stringify(tools) !== JSON.stringify(settings.enabledTools)
  useUnsaved(dirty)
  return <form onSubmit={event => { event.preventDefault(); if (!dirty || busy) return; setBusy(true); setError(''); void request(`/settings?businessId=${business.id}`, token, { method: 'PATCH', body: { version: settings.version, language, tone, requireApproval: true, refundLimitCents: Math.round(Number(limit) * 100), duplicateWindowMinutes: Number(windowMinutes), enabledTools: tools } }).then(onSaved).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)) }}>
    <div className="two-columns settings-columns"><div className="settings-stack"><section className="card padded"><h2>Спілкування з клієнтом</h2><p className="muted">Базові побажання до нових відповідей AI.</p><label htmlFor="language">Мова відповіді</label><select id="language" value={language} onChange={event => setLanguage(event.target.value)}><option value="uk">Українська</option><option value="en">English</option></select><label htmlFor="tone">Тон спілкування</label><select id="tone" value={tone} onChange={event => setTone(event.target.value)}><option value="neutral">Нейтральний</option><option value="empathetic">Емпатійний</option><option value="de-escalating">Деескалаційний</option></select></section><section className="card padded"><h2>Дозволені інструменти</h2><p className="muted">Інструмент у списку все одно проходить перевірку політики.</p>{['lookup_payments', 'refund_payment', 'escalate_to_human'].map(tool => <label className="check-option" key={tool}><input type="checkbox" checked={tools.includes(tool)} onChange={event => setTools(previous => event.target.checked ? [...previous, tool] : previous.filter(item => item !== tool))} /><span>{toolLabels[tool]}<small>{tool === 'lookup_payments' ? 'Лише читання платежів цього клієнта' : tool === 'refund_payment' ? 'Фінансова дія після погодження' : 'Передавання розмови людині'}</small></span></label>)}</section></div>
      <div className="settings-stack"><section className="card padded"><h2>Правила дій</h2><p className="muted">Сервер повторно перевіряє правила перед виконанням.</p><label htmlFor="refund-limit">Гранична сума повернення, {business.currency}</label><input id="refund-limit" type="number" min="0.01" max="1000000" step="0.01" required value={limit} onChange={event => setLimit(event.target.value)} /><label htmlFor="duplicate-window">Вікно подвійного списання, хвилин</label><input id="duplicate-window" type="number" min="1" max="1440" step="1" required value={windowMinutes} onChange={event => setWindowMinutes(event.target.value)} /><div className="required-approval"><Icon name="lock" /><div><strong>Повернення потребують погодження</strong><p>Фінансові дії проходять через людину. Це правило не можна вимкнути.</p></div></div></section><RuntimeDetails token={token} /></div>
    </div>{error && <Notice error>{error} Якщо версія змінилася, оновіть сторінку та повторно перевірте зміни.</Notice>}<div className="settings-save"><span className="muted">{dirty ? 'Є незбережені зміни' : 'Усі зміни збережено'} · v{settings.version}</span><button className="primary" type="submit" disabled={!dirty || busy}>{busy ? 'Зберігаємо…' : 'Зберегти зміни'}</button></div>
  </form>
}

function useUnsaved(dirty: boolean) {
  const scopeRef = useContext(DirtyScope)
  useEffect(() => {
    if (scopeRef) scopeRef.current = dirty
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const removeGuard = registerNavigationGuard(() => allowDiscard(true))
    window.addEventListener('beforeunload', warn)
    return () => { removeGuard(); if (scopeRef) scopeRef.current = false; window.removeEventListener('beforeunload', warn) }
  }, [dirty, scopeRef])
}
function allowDiscard(dirty: boolean) { return !dirty || window.confirm('Є незбережені зміни. Залишити їх і продовжити?') }
function roleLabel(role: string) { return ({ staff: 'Оператор', operator: 'Оператор', admin: 'Адміністратор', 'support-agent': 'Оператор підтримки' } as Record<string, string>)[role] ?? role }

function RuntimeDetails({ token }: { token: string }) {
  const resource = useResource<{ runtime: string; provider: string; model: string; persistence: string; paymentProvider: string; credentialsConfigured: boolean; knowledgeSearch: string; maxToolCalls: number }>('/capabilities', token, 15000)
  const data = resource.data
  return <section className="card padded"><h2>Виконання та інтеграції</h2>{data ? <><div className="integration-row"><Icon name="spark" /><div><strong>{data.runtime === 'dsh' ? 'DeepSeek Harness' : 'Детерміновані правила'}</strong><small>{data.provider} · {data.model}</small><small>{data.credentialsConfigured ? 'Серверні облікові дані налаштовано' : 'Ключ моделі не налаштовано'}</small></div><Badge value={data.runtime === 'dsh' ? 'llm' : 'fallback'}>{data.runtime === 'dsh' ? 'DSH' : 'Rules'}</Badge></div><div className="integration-row"><Icon name="book" /><div><strong>Сховище {data.persistence === 'postgres' ? 'PostgreSQL' : 'у пам’яті'}</strong><small>{data.persistence === 'memory' ? 'Дані цього середовища зникають після перезапуску сервера.' : 'Дані зберігаються між перезапусками сервера.'}</small><small>Пошук знань: {data.knowledgeSearch === 'hybrid' ? 'гібридний (ключові слова + вектори)' : data.knowledgeSearch === 'lexical' ? 'лексичний' : data.knowledgeSearch}. Ліміт викликів: {data.maxToolCalls}.</small></div></div></> : <p className="muted">{resource.error || 'Отримуємо фактичну конфігурацію…'}</p>}<div className="integration-row"><Icon name="lock" /><div><strong>Платежі</strong><small>Симульований провайдер. Реальні кошти не переміщуються.</small></div><Badge value="draft">Симуляція</Badge></div><p className="field-hint">API-ключі та секрети не зберігаються в налаштуваннях браузера.</p></section>
}

function Skills({ token, business }: { token: string; business: Business }) {
  const resource = useResource<{ skills: { id: string; name: string; content: string; revision: number; enabled: boolean; updatedAt: string }[]; preset: string }>(`/skills?businessId=${business.id}`, token)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  return <section className="card padded skills-section"><div className="page-heading"><div><h2>Навички помічника</h2><p>Додаткові бізнес-інструкції. Вони не змінюють права інструментів.</p></div><button type="button" onClick={() => setCreating(value => !value)}><Icon name="plus" size={17} />Додати навичку</button></div>{resource.error && <Notice error>{resource.error}</Notice>}{notice && <Notice>{notice}</Notice>}{resource.data && <><Badge>Набір {resource.data.preset}</Badge>{resource.data.skills.length ? resource.data.skills.map(skill => <details className="skill-item" key={skill.id}><summary>{skill.name} · v{skill.revision} · {skill.enabled ? 'Увімкнено' : 'Вимкнено'}</summary><p className="skill-content">{skill.content}</p><small className="muted">Оновлено {dateTime(skill.updatedAt)}</small></details>) : <p className="muted small">Власних навичок ще немає.</p>}</>}{creating && <form className="skill-create" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError(''); void request(`/skills?businessId=${business.id}`, token, { method: 'POST', body: { name: `custom/${String(data.get('name')).trim()}`, content: String(data.get('content')).trim(), enabled: true } }).then(() => { setCreating(false); setNotice('Навичку збережено. Вона доступна наступним запускам агента.'); resource.refresh() }).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)) }}><label htmlFor="skill-name">Назва після custom/</label><input id="skill-name" name="name" required pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="billing-support" /><label htmlFor="skill-content">Інструкція</label><textarea id="skill-content" name="content" required maxLength={30000} rows={5} /><p className="field-hint">Використовуйте малі латинські літери, цифри та дефіси. Секрети й облікові дані сюди не додаються.</p>{error && <Notice error>{error}</Notice>}<button className="primary" disabled={busy}>{busy ? 'Зберігаємо…' : 'Зберегти навичку'}</button></form>}</section>
}
