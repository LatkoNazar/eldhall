import type { Analysis, Intent, Priority, Sentiment } from '../support/contracts.js';

// Inspectable lexical signals. Sentiment drives priority, tone and escalation only —
// it never authorises an action (policy.ts does not read it).
const ABUSIVE = ['idiot', 'stupid', 'moron', 'fuck', 'shit', 'scammers', 'ідіот', 'дебіл', 'придурк', 'бляд', 'шахраї', 'покидьк'];
const FRUSTRATED = ['twice', 'again', 'ridiculous', 'unacceptable', 'still', 'nobody', 'worst', 'двічі', 'знову', 'досі', 'жах', 'неприпустим', 'обурен'];
const URGENT = ['now', 'immediately', 'asap', 'urgent', 'today', 'негайно', 'терміново', 'зараз', 'сьогодні'];

export function lexicalSentiment(text: string): Sentiment {
  const lower = text.toLowerCase();
  const hits = (words: string[]) => words.filter(word => lower.includes(word));
  const abusive = hits(ABUSIVE);
  const frustrated = hits(FRUSTRATED);
  const urgent = hits(URGENT);
  const letters = text.match(/\p{L}/gu) ?? [];
  const upper = text.match(/\p{Lu}/gu) ?? [];
  const shouting = letters.length >= 8 && upper.length / letters.length > 0.6;
  const exclamations = (text.match(/!/g) ?? []).length;
  const signals = [
    ...abusive.map(w => `abusive word: "${w}"`),
    ...frustrated.map(w => `frustration marker: "${w}"`),
    ...urgent.map(w => `urgency marker: "${w}"`),
    ...(shouting ? ['mostly uppercase (shouting)'] : []),
    ...(exclamations >= 2 ? [`${exclamations} exclamation marks`] : []),
  ];
  const frustration = Math.min(1, frustrated.length * 0.25 + (shouting ? 0.3 : 0) + Math.min(exclamations, 4) * 0.1 + abusive.length * 0.3);
  const urgency = urgent.length >= 1 || exclamations >= 3 ? 'high' : frustration >= 0.4 ? 'medium' : 'low';
  const label = abusive.length ? 'abusive' : frustration >= 0.6 ? 'angry' : frustration >= 0.25 ? 'frustrated' : 'calm';
  const escalationRisk = Math.min(1, frustration * 0.7 + (abusive.length ? 0.5 : 0) + (urgency === 'high' ? 0.1 : 0));
  return { label, frustration: round(frustration), abusive: abusive.length > 0, urgency, escalationRisk: round(escalationRisk), signals };
}

const LABELS: Sentiment['label'][] = ['calm', 'frustrated', 'angry', 'abusive'];
const URGENCIES: Sentiment['urgency'][] = ['low', 'medium', 'high'];

/** Combine deterministic signals with the model's label; the more severe reading wins. */
export function mergeSentiment(lexical: Sentiment, model: { label: Sentiment['label']; urgency: Sentiment['urgency'] }): Sentiment {
  const label = LABELS[Math.max(LABELS.indexOf(lexical.label), LABELS.indexOf(model.label))]!;
  const urgency = URGENCIES[Math.max(URGENCIES.indexOf(lexical.urgency), URGENCIES.indexOf(model.urgency))]!;
  const signals = model.label !== lexical.label ? [...lexical.signals, `model reading: ${model.label}`] : lexical.signals;
  const floor = { calm: 0, frustrated: 0.3, angry: 0.6, abusive: 0.8 }[label];
  return { ...lexical, label, urgency, signals, abusive: label === 'abusive', frustration: Math.max(lexical.frustration, floor), escalationRisk: Math.max(lexical.escalationRisk, floor * 0.8) };
}

const MONEY: Intent[] = ['duplicate_charge', 'refund_request', 'billing_question'];

export function priorityFor(sentiment: Sentiment, intent: Intent): Priority {
  if (sentiment.abusive || sentiment.urgency === 'high' || sentiment.escalationRisk >= 0.7) return 'P1';
  if (MONEY.includes(intent) || sentiment.frustration >= 0.4) return 'P2';
  return 'P3';
}

export function toneFor(sentiment: Sentiment): Analysis['tone'] {
  if (sentiment.label === 'abusive' || sentiment.label === 'angry') return 'de-escalating';
  return sentiment.label === 'frustrated' ? 'empathetic' : 'neutral';
}

const round = (value: number) => Math.round(value * 100) / 100;
