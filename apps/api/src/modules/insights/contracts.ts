import { z } from 'zod';

const uuid = z.uuid();
export const insightOutputSchema = z.strictObject({
  findings: z.array(z.strictObject({
    kind: z.enum(['recurring_issue', 'knowledge_gap', 'possible_contradiction']),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1200),
    recommendation: z.string().trim().min(1).max(800),
    evidence: z.array(z.strictObject({ caseId: uuid, messageIds: z.array(uuid).min(1).max(8) })).min(1).max(25),
    knowledgeRefs: z.array(z.strictObject({ id: uuid, version: z.number().int().positive() })).max(20),
    proposedArticle: z.strictObject({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(6000) }).nullable(),
  })).max(8),
});
export type InsightOutput = z.infer<typeof insightOutputSchema>;
export type InsightFinding = InsightOutput['findings'][number] & { id: string; caseCount: number; draftId: string | null };
export interface InsightSample {
  caseCount: number; messageCount: number; knowledgeCount: number; totalCases: number; totalPublishedKnowledge: number;
  truncated: boolean; from: string | null; to: string | null;
}
export interface InsightRun {
  id: string; businessId: string; status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string; completedAt: string | null; provider: string; model: string;
  sample: InsightSample; findings: InsightFinding[]; error: string | null; stale: boolean;
}
export interface InsightInput {
  tickets: { id: string; messages: { id: string; role: string; body: string }[] }[];
  knowledge: { id: string; version: number; title: string; content: string }[];
  sourceRefs: { id: string; version: number }[];
  sample: InsightSample;
}
export interface InsightModel {
  readonly provider: string; readonly model: string;
  analyze(input: InsightInput, context: { businessId: string; runId: string; assertActive: () => Promise<void> }, signal: AbortSignal): Promise<InsightOutput>;
}
export interface InsightLease { id: string; businessId: string; owner: string; fence: number; limit: number }
export class InsightError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const emptySample = (): InsightSample => ({ caseCount: 0, messageCount: 0, knowledgeCount: 0, totalCases: 0, totalPublishedKnowledge: 0, truncated: false, from: null, to: null });
