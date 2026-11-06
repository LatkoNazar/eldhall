import { useId } from 'react'
import { useI18n } from '../../i18n'
import type { ImportCandidate, ScopeBinding } from '../../lib/integration-imports-api'
import type { ReviewDraft } from '../../lib/integration-review'

export function OperationReviewFields({ operation, value, disabled, guards, reads, onChange }: {
  operation: ImportCandidate; value: ReviewDraft; disabled: boolean; guards: { id: string; name: string }[]
  reads: { operationKey: string; title: string }[]; onChange: (value: ReviewDraft) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const update = (patch: Partial<ReviewDraft>) => onChange({ ...value, ...patch })
  return <fieldset className="operation-review-fields" disabled={disabled}>
    <legend>{t('onboarding.reviewRequired')}</legend>

    <Binding label={t('onboarding.customerScope')} location={value.customerLocation} name={value.customerName} onChange={(location, name) => update({ customerLocation: location, customerName: name })} />
    <p className="field-hint">{t('onboarding.scopeHint')}</p>
    <label className="check-option"><input type="checkbox" checked={value.bindBusiness} onChange={event => update({ bindBusiness: event.target.checked })} />{t('onboarding.businessScope')}</label>
    {value.bindBusiness && <Binding label={t('onboarding.optionalBusiness')} location={value.businessLocation} name={value.businessName} onChange={(location, name) => update({ businessLocation: location, businessName: name })} />}
    <label>{t('onboarding.outputs')}<input value={value.outputs} onChange={event => update({ outputs: event.target.value })} aria-describedby={`${id}-outputs`} maxLength={2100} /></label>
    <p className="field-hint" id={`${id}-outputs`}>{t('onboarding.outputHint')}</p>
    {operation.outputCandidates.length > 0 && <p className="small"><code>{operation.outputCandidates.join(', ')}</code></p>}
    <details><summary>{t('onboarding.advancedSource')}</summary>
      <label>{t('onboarding.guard')}<select value={value.guard} onChange={event => update({ guard: event.target.value })}><option value="">{t('onboarding.noGuard')}</option>{guards.map(guard => <option value={guard.id} key={guard.id}>{guard.name}</option>)}</select></label>
      {value.effect === 'write' && <><label>{t('onboarding.idempotency')}<input value={value.idempotencyHeader} list={`${id}-headers`} maxLength={64} onChange={event => update({ idempotencyHeader: event.target.value })} /></label><datalist id={`${id}-headers`}>{operation.idempotencyHeaderCandidates.map(header => <option key={header} value={header} />)}</datalist><p className="field-hint">{t('onboarding.idempotencyHint')}</p>
        <label>{t('onboarding.reconciliation')}<select value={value.reconciliationKey} onChange={event => update({ reconciliationKey: event.target.value })}><option value="">{t('onboarding.noReconciliation')}</option>{reads.filter(read => read.operationKey !== operation.operationKey).map(read => <option key={read.operationKey} value={read.operationKey}>{read.title} · {read.operationKey}</option>)}</select></label></>}
      <pre>{JSON.stringify({ inputSchema: operation.inputSchema, parameters: operation.parameters }, null, 2)}</pre>
    </details>
  </fieldset>
}

function Binding({ label, location, name, onChange }: { label: string; location: ScopeBinding['in']; name: string; onChange: (location: ScopeBinding['in'], name: string) => void }) {
  const { t } = useI18n()
  return <fieldset className="scope-binding"><legend>{label}</legend><label>{t('onboarding.location')}<select value={location} onChange={event => onChange(event.target.value as ScopeBinding['in'], name)}>{(['header', 'path', 'query', 'body'] as const).map(place => <option key={place} value={place}>{place}</option>)}</select></label><label>{t('onboarding.field')}<input value={name} maxLength={64} onChange={event => onChange(location, event.target.value)} /></label></fieldset>
}
