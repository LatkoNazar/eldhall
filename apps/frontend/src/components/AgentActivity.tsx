import { useState } from 'react'
import { useI18n, formatDateTime, formatNumber } from '../i18n'
import type { CaseDetail } from '../lib/api'
import type { ActivityContext, ActivityFacts } from '../lib/banking'
import { requestLabel } from '../lib/request-catalog'
import { Icon, Notice } from './ui'

/** Public server activity only; never render raw runtime events or SDK transcripts. */
export function AgentActivity({ detail, selectedRequestId }: { detail: CaseDetail; selectedRequestId: string | null }) {
  const { t, locale } = useI18n()
  const [requestOnly, setRequestOnly] = useState(false)
  const activity = detail.agentActivity
  const selected = detail.requestCatalog?.requests.find(item => item.id === selectedRequestId)
  const events = (activity?.events ?? []).filter(event => !requestOnly || !selected || event.requestIds.includes(selected.id))
  return <details className="agent-activity"><summary><Icon name="spark" size={16} />{t('bank.activity.title')}</summary><p className="field-hint">{t('bank.activity.description')}</p>
    {selected && <label className="check-option"><input type="checkbox" checked={requestOnly} onChange={event => setRequestOnly(event.target.checked)} />{t('bank.activity.requestOnly', { request: requestLabel(selected) })}</label>}
    {!activity || activity.status === 'not_recorded' ? <><Notice>{t('bank.activity.notRecorded')}</Notice>{detail.runs.length > 0 && <details><summary>{t('bank.activity.legacyRuns')}</summary><ul>{detail.runs.map(run => <li key={run.id}>{run.provider} · {run.model}<small>{formatDateTime(run.createdAt, locale)} · {formatNumber(run.latencyMs, locale)} ms</small><p>{run.toolCalls.join(', ') || '—'}</p></li>)}</ul></details>}</> : <>
      {activity.hasMore && <Notice>{t('bank.activity.partial')}</Notice>}
      {!events.length && <p className="muted">{t('bank.activity.empty')}</p>}
      <ol className="timeline activity-events">{events.map(event => <li key={event.id} data-activity-id={event.id}>
        <div className="activity-event-heading"><strong>{t(`bank.activity.type.${event.type}`)}</strong><span className="badge">{t(`bank.activity.outcome.${event.outcome}`)}</span></div>
        <small>{formatDateTime(event.createdAt, locale)}{event.tool && <> · {event.tool}</>}</small><p>{event.summary}</p>
        {event.reason && <section><h4>{t('bank.activity.reason')}</h4><p>{event.reason}</p></section>}
        {event.requestIds.length > 0 && <p className="small">{t('bank.activity.linkedRequests')} {event.requestIds.map(id => detail.requestCatalog!.requests.find(item => item.id === id)).filter(item => !!item).map(item => requestLabel(item)).join(', ')}</p>}
        {event.input && <details><summary>{t('bank.activity.input')}</summary><Facts value={event.input} /></details>}{event.result && <details><summary>{t('bank.activity.result')}</summary><Facts value={event.result} /></details>}
        {event.checks.length > 0 && <details><summary>{t('bank.activity.checks')}</summary><ul>{event.checks.map((check, index) => <li key={index}><strong>{check.passed ? t('core.action.passed') : t('core.action.notPassed')} · {check.name}</strong><p>{check.detail}</p></li>)}</ul></details>}
        {event.context && <RunContext value={event.context} />}
        <details><summary>{t('presentation.references')}</summary><dl className="facts"><dt>{t('bank.activity.run')}</dt><dd>{event.runId}</dd>{event.callId && <><dt>{t('bank.activity.call')}</dt><dd>{event.callId}</dd></>}{event.proposalId && <><dt>{t('bank.activity.proposal')}</dt><dd>{event.proposalId}</dd></>}</dl></details>
      </li>)}</ol>
    </>}
  </details>
}

function Facts({ value }: { value: ActivityFacts }) {
  const { locale } = useI18n()
  return <dl className="facts activity-facts">{Object.entries(value).map(([key, field]) => <div key={key}><dt>{key}</dt><dd>{field === null ? '—' : Array.isArray(field) ? field.join(', ') : typeof field === 'number' ? formatNumber(field, locale) : String(field)}</dd></div>)}</dl>
}

function RunContext({ value }: { value: ActivityContext }) {
  const { t, locale } = useI18n()
  return <details><summary>{t('bank.activity.context')}</summary><dl className="facts"><dt>{t('bank.activity.settingsVersion')}</dt><dd>{formatNumber(value.settingsVersion, locale)}</dd><dt>{t('bank.guards.revision', { version: value.guardRevision })}</dt><dd>{formatNumber(value.guardRevision, locale)}</dd><dt>{t('operations.runtime.title')}</dt><dd>{value.provider} · {value.model}</dd></dl>
    <h4>{t('operations.skills.title')}</h4><ul>{value.skills.map(skill => <li key={skill.id}><strong>{skill.name} · v{formatNumber(skill.revision, locale)}</strong><p className="small">{t('bank.activity.skillLoaded', { loaded: skill.loadedCharacters, total: skill.totalCharacters })}</p><pre>{skill.preview}</pre>{skill.truncated && <p className="field-hint">{t('bank.activity.previewShortened')}</p>}<small className="break-word">SHA-256: {skill.contentHash}</small></li>)}</ul>
    <h4>{t('bank.guards.title')}</h4><ul>{value.guards.map(guard => <li key={guard.id}><strong>{guard.name}</strong> · {t(`bank.guards.kind.${guard.kind}`)} · {guard.enabled ? t('operations.skills.enabled') : t('operations.skills.disabled')}<p>{guard.reason}</p></li>)}</ul><details><summary>{t('bank.activity.guardSnapshot')}</summary><pre>{JSON.stringify(value.guards, null, 2)}</pre></details>
  </details>
}
