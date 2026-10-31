import { z } from 'zod';
import type { AgentContext } from './model.js';

const classId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);

/** Operator-owned taxonomy. Labels and examples never grant tool permissions. */
export const classificationConfigSchema = z.object({
  revision: z.number().int().positive(),
  fallbackClassId: classId,
  minimumConfidence: z.number().finite().min(0).max(1).default(0.6),
  classes: z.array(z.object({
    id: classId,
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    examples: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  }).strict()).min(2).max(50),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.classes.map(item => item.id)).size !== config.classes.length) ctx.addIssue({ code: 'custom', message: 'Classification class IDs must be unique' });
  if (!config.classes.some(item => item.id === config.fallbackClassId)) ctx.addIssue({ code: 'custom', message: 'Classification fallback must reference a configured class' });
  if (JSON.stringify(config).length > 16_000) ctx.addIssue({ code: 'custom', message: 'Classification taxonomy exceeds the 16000-character context budget' });
});
export type ClassificationConfig = z.infer<typeof classificationConfigSchema>;

export const classificationDecisionSchema = z.object({
  classId,
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().trim().min(1).max(400),
}).strict();
export type ClassificationDecision = z.infer<typeof classificationDecisionSchema>;
export interface ClassificationInput {
  businessId: string;
  taxonomy: ClassificationConfig;
  history: AgentContext['history'];
  message: string;
}
export interface TicketClassifier {
  readonly provider: string;
  readonly model: string;
  readonly scoreKind?: 'model_self_report' | 'selected_probability';
  classify(input: ClassificationInput, signal: AbortSignal): Promise<ClassificationDecision>;
}

export interface TicketClassification {
  classId: string;
  label: string;
  confidence: number;
  reason: string;
  revision: number;
  needsReview: boolean;
  source: 'llm' | 'fallback';
  provider?: string;
  model?: string;
  scoreKind?: TicketClassifier['scoreKind'];
  proposedClassId?: string;
  proposedLabel?: string;
  reasonCode: 'classified' | 'low_confidence' | 'unknown_class' | 'missing_classification' | 'invalid_classification' | 'model_fallback';
}

/** Keep a useful support decision even when its independent category is missing or invalid. */
export function normalizeClassification(config: ClassificationConfig | null | undefined, input: unknown, source: TicketClassification['source'], provenance: Pick<TicketClassification, 'provider' | 'model' | 'scoreKind'> = {}): TicketClassification | null {
  if (!config) return null;
  const fallback = config.classes.find(item => item.id === config.fallbackClassId)!;
  const base = { classId: fallback.id, label: fallback.label, confidence: 0, revision: config.revision, needsReview: true, source, ...provenance };
  if (source === 'fallback') return { ...base, reasonCode: 'model_fallback', reason: 'The model was unavailable; custom classification requires human review.' };
  if (input === null || input === undefined) return { ...base, reasonCode: 'missing_classification', reason: 'The model did not provide a category; human review is required.' };
  const parsed = classificationDecisionSchema.safeParse(input);
  if (!parsed.success) return { ...base, reasonCode: 'invalid_classification', reason: 'The model returned an invalid category result; human review is required.' };
  const match = config.classes.find(item => item.id === parsed.data.classId);
  if (!match) return { ...base, reasonCode: 'unknown_class', reason: 'The proposed category is outside this business taxonomy; human review is required.' };
  if (parsed.data.confidence < config.minimumConfidence) return { ...base, confidence: parsed.data.confidence, proposedClassId: match.id, proposedLabel: match.label, reasonCode: 'low_confidence', reason: parsed.data.reason };
  return { classId: match.id, label: match.label, confidence: parsed.data.confidence, reason: parsed.data.reason, revision: config.revision,
    needsReview: match.id === config.fallbackClassId, source, reasonCode: 'classified', ...provenance };
}

export function sameClassificationConfig(left: ClassificationConfig | null | undefined, right: ClassificationConfig | null | undefined): boolean {
  return JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
