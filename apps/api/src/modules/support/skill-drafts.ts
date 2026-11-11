import { z } from 'zod';
import { parseSkillContext } from '../agent/context.js';
import type { SupportSettings, SupportSkill } from './contracts.js';

export const customSkillName = /^custom\/[a-z0-9][a-z0-9-]{0,63}$/;
const maxCatalog = 48;
const maxExcerpts = 8;
const maxDraftBody = 6_000;
export const skillDraftRequest = z.strictObject({ description: z.string().trim().min(10).max(6_000) });
export const relatedSkillIds = z.array(z.uuid()).max(4).refine(ids => ids.length === new Set(ids).size);
const outputSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  purpose: z.string().trim().min(1).max(240).regex(/^[^\r\n]+$/),
  instructions: z.string().trim().min(1).max(maxDraftBody).refine(value => !value.startsWith('---')),
  related: z.array(z.strictObject({
    id: z.uuid(), kind: z.enum(['reuse', 'overlap']), reason: z.string().trim().min(1).max(300),
  })).max(4),
});

export interface SkillDraftInput {
  description: string;
  skills: { id: string; name: string; purpose: string; enabled: boolean; excerpt?: string }[];
  totalSkills: number;
  tools: string[];
  guardKinds: string[];
}
export interface SkillDraftModel {
  generate(input: SkillDraftInput, businessId: string, signal: AbortSignal): Promise<unknown>;
}

const tokens = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

export function skillDraftInput(description: string, skills: SupportSkill[], settings: SupportSettings): SkillDraftInput {
  const query = new Set(tokens(description));
  const ranked = skills.map(skill => {
    const metadata = parseSkillContext(skill);
    const terms = new Set(tokens(`${skill.name} ${metadata.purpose} ${metadata.content.slice(0, 1_500)}`));
    const score = [...query].filter(word => terms.has(word)).length;
    return { skill, metadata, score };
  }).sort((a, b) => b.score - a.score || Number(b.skill.enabled) - Number(a.skill.enabled) || a.skill.name.localeCompare(b.skill.name));
  return {
    description,
    skills: ranked.slice(0, maxCatalog).map(({ skill, metadata }, index) => ({
      id: skill.id, name: skill.name.slice(0, 128), purpose: metadata.purpose.slice(0, 240), enabled: skill.enabled,
      ...(index < maxExcerpts ? { excerpt: metadata.content.slice(0, 900) } : {}),
    })),
    totalSkills: skills.length,
    tools: settings.enabledTools,
    guardKinds: [...new Set((settings.guards ?? []).map(rule => rule.kind))],
  };
}

export function reviewSkillDraft(input: SkillDraftInput, result: unknown, current: SupportSkill[]) {
  const draft = outputSchema.parse(result);
  const supplied = new Set(input.skills.map(skill => skill.id));
  const seen = new Set<string>();
  const related = draft.related.map(item => {
    const skill = current.find(row => row.id === item.id);
    if (!skill || !supplied.has(item.id) || seen.has(item.id)) throw new Error('Invalid skill draft reference');
    seen.add(item.id);
    return { ...item, kind: skill.enabled ? item.kind : 'overlap' as const, name: skill.name, revision: skill.revision, enabled: skill.enabled };
  });
  const occupied = new Set(current.map(skill => skill.name));
  let slug = draft.slug;
  for (let suffix = 2; occupied.has(`custom/${slug}`); suffix++) {
    const tail = `-${suffix}`;
    slug = draft.slug.slice(0, 64 - tail.length).replace(/-+$/, '') + tail;
  }
  const purpose = draft.purpose.replace(/^["']|["']$/g, '').trim();
  const content = `---\nactivation: on_demand\ndescription: ${JSON.stringify(purpose)}\n---\n${draft.instructions}`;
  if (parseSkillContext({ name: slug, content }).activation !== 'on_demand') throw new Error('Invalid skill draft purpose');
  return { slug, content, related, reviewedSkills: input.skills.length, totalSkills: input.totalSkills };
}

/** References use the existing scoped context loader. A reference grants no access by itself. */
export function withRelatedSkills(name: string, content: string, related: SupportSkill[]): string {
  if (!related.length) return content;
  const body = parseSkillContext({ name, content }).content;
  const header = content.slice(0, content.length - body.length);
  const references = related.map(skill => `- ${JSON.stringify(skill.name)} (skill ID: ${skill.id})`).join('\n');
  return `${header}## Related skills\nWhen applicable, load the following enabled skills from the current support context by their IDs. If a skill is unavailable, use current policy or ask an operator.\n${references}\n\n${body}`;
}
