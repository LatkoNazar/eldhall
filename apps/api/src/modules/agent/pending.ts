import type { AgentDecision } from './model.js';

/** A durable proposal ends the model turn. The application owns this decision;
 * an operator's later approval/execution is a separate request, never an LLM wait. */
export function approvalPendingDecision(summary: string, language: 'uk' | 'en' = 'en'): AgentDecision {
  return {
    intent: 'other', summary: (language === 'uk' ? `Очікує погодження оператора: ${summary}` : `Awaiting operator approval: ${summary}`).slice(0, 400),
    reasoning: language === 'uk' ? 'Пропозицію записано. Виконання операції ще не підтверджено.' : 'The backend recorded a proposal; no business effect has been confirmed.',
    sentiment: { label: 'calm', urgency: 'low' },
    reply: 'The request is awaiting operator approval.', action: null,
  };
}
