import type { TicketClassification } from '../lib/api'
import { Badge } from './ui'

export function ClassificationSummary({ classification }: { classification: TicketClassification }) {
  return <section className="inspector-section" aria-label="Класифікація тікета">
    <h3>Класифікація тікета</h3>
    <p className="break-word"><Badge>{classification.label}</Badge> <small className="muted">ID {classification.classId} · версія {classification.revision}</small></p>
    <p className="break-word">{classification.reason}</p>
    {(classification.provider || classification.model) && <p className="small muted break-word">Класифікатор: {[classification.provider, classification.model].filter(Boolean).join(' · ')}</p>}
    {classification.proposedClassId && classification.proposedLabel && <p className="small break-word">Запропонований кандидат: <strong>{classification.proposedLabel}</strong> · ID {classification.proposedClassId}</p>}
    {classification.source === 'llm' && ['classified', 'low_confidence'].includes(classification.reasonCode) ? <p className="small">{classification.scoreKind === 'selected_probability' ? 'Імовірність вибору' : 'Оцінка впевненості моделі'}{classification.proposedClassId ? ' для кандидата' : ''}: {new Intl.NumberFormat('uk-UA', { style: 'percent', maximumFractionDigits: 0 }).format(classification.confidence)}</p> : <p className="small">Резервна класифікація: модель не визначила допустимий клас.</p>}
    {classification.needsReview && <p className="small"><Badge value="pending">Потребує перевірки оператором</Badge></p>}
    <p className="muted small">Це оцінка моделі, не виміряна точність. Клас не надає дозволу виконувати дії.</p>
  </section>
}
