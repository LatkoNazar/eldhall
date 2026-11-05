import { useI18n } from '../i18n'
import type { CaseDetail, Proposal } from '../lib/api'
import { factText, presentProposal, type PresentationId, type Projection } from '../lib/presentation'
import { Icon } from './ui'

const icons: Record<PresentationId, string> = { generic: 'inbox', payments: 'chart', delivery: 'send', orders: 'file', returns: 'refresh', booking: 'clock', appointments: 'user', subscription: 'refresh', account: 'user', access: 'key', incident: 'alert', warranty: 'check', escalation: 'team' }
export function ProposalContext({ proposal, detail }: { proposal: Proposal; detail: CaseDetail }) {
  const { t } = useI18n()
  const view = presentProposal(proposal, detail)
  return <div className={`proposal-context domain-${view.id}`} data-template={view.id}>
    <div className="domain-heading"><Icon name={icons[view.id]} size={18} /><strong>{t(`presentation.template.${view.id}`)}</strong></div>
    {view.id === 'generic' && <p className="small muted">{t('presentation.genericHint')}</p>}
    <ContextFields projection={view.requested} confirmed={false} generic={view.id === 'generic'} />
    <ContextFields projection={view.confirmed} confirmed generic={view.id === 'generic'} />
    {(view.requested.conflicting || view.confirmed.conflicting) && <p className="field-hint">{t('presentation.conflicting')}</p>}
  </div>
}
function ContextFields({ projection, confirmed, generic }: { projection: Projection; confirmed: boolean; generic: boolean }) {
  const { t, locale } = useI18n()
  return <section className={`domain-record ${confirmed ? 'domain-confirmed' : 'domain-requested'} ${projection.facts.length ? 'has-facts' : ''}`} aria-label={t(confirmed ? 'presentation.confirmed' : 'presentation.requested')}>
    <h4>{t(confirmed ? 'presentation.confirmed' : 'presentation.requested')}</h4>
    {projection.facts.length ? <dl className="facts">{projection.facts.map(fact => <div className="domain-fact" key={fact.id}><dt>{t(fact.label)}</dt><dd>{fact.kind === 'date' ? <time dateTime={String(fact.value)}>{factText(fact, locale)}</time> : factText(fact, locale)}</dd></div>)}</dl> : <p className="small muted">{t(confirmed ? 'presentation.noConfirmed' : 'presentation.noRequested')}</p>}
    {projection.partial && !generic && <p className="field-hint" role="note">{t(confirmed ? 'presentation.partialConfirmed' : 'presentation.partialRequested')}</p>}
  </section>
}
