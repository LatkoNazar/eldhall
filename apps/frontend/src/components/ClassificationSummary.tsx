import { useI18n, formatPercent } from '../i18n'
import type { TicketClassification } from '../lib/api'
import { Badge } from './ui'

export function ClassificationSummary({ classification }: { classification: TicketClassification }) {
  const { t, locale } = useI18n()
  return <section className="inspector-section" aria-label={t("core.classification.title")}>
    <h3>{t("core.classification.title")}</h3>
    <p className="break-word"><Badge>{classification.label}</Badge> <small className="muted">ID {classification.classId}  {t("core.common.version")} {classification.revision}</small></p>
    <p className="break-word">{classification.reason}</p>
    {(classification.provider || classification.model) && <p className="small muted break-word">{t("core.classification.classifier")} {[classification.provider, classification.model].filter(Boolean).join(' · ')}</p>}
    {classification.proposedClassId && classification.proposedLabel && <p className="small break-word">{t("core.classification.candidate")} <strong>{classification.proposedLabel}</strong> · ID {classification.proposedClassId}</p>}
    {classification.source === 'llm' && ['classified', 'low_confidence'].includes(classification.reasonCode) ? <p className="small">{classification.scoreKind === 'selected_probability' ? t("core.classification.probability") : t("core.classification.confidence")}{classification.proposedClassId ? " " + t("core.classification.forCandidate") + "" : ''}: {formatPercent(classification.confidence, locale)}</p> : <p className="small">{t("core.classification.fallback")}</p>}
    {classification.needsReview && <p className="small"><Badge value="pending">{t("core.classification.review")}</Badge></p>}
    <p className="muted small">{t("core.classification.disclaimer")}</p>
  </section>
}
