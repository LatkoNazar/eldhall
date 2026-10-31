import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * SKILL.md packs (knowledge/skills/, two layers) -> rows of the support config file.
 *
 *   universal/<procedure>/SKILL.md   -> support skills   (how to handle a kind of request, any business)
 *   <business>/<fact-sheet>/SKILL.md -> support knowledge (the business's published facts, versioned)
 *
 * Frontmatter: name, description, metadata.{layer, business, title, category, version, status, updated, source}.
 * Ids are derived from business id + layer + name, so re-importing updates the same rows and the
 * config bootstrap only applies a higher version/revision.
 */

export interface SkillFile {
  path: string;
  name: string;
  description: string;
  layer: 'universal' | 'business';
  business: string | null;
  title: string;
  category: string;
  version: number;
  status: 'published' | 'draft';
  updated: string | null;
  source: string | null;
  body: string;
}

export interface ImportedKnowledge { id: string; businessId: string; title: string; category: string; content: string; version: number; status: 'draft' | 'published' | 'revoked'; updatedAt: string }
export interface ImportedSkill { id: string; businessId: string; name: string; content: string; revision: number; enabled: boolean; updatedAt: string }

/** Small YAML subset used by SKILL.md: `key: value`, one nested map level, quoted scalars, `>`/`|` blocks. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, unknown> = {};
  let parent: Record<string, unknown> | null = null;
  let block: { target: Record<string, unknown>; key: string; indent: number; fold: boolean; lines: string[] } | null = null;
  const flush = () => { if (block) block.target[block.key] = block.lines.join(block.fold ? ' ' : '\n').trim(); block = null; };
  for (const raw of match[1]!.split(/\r?\n/)) {
    const indent = raw.length - raw.trimStart().length;
    if (block && (indent > block.indent || !raw.trim())) { block.lines.push(raw.trim()); continue; }
    flush();
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const pair = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!pair) continue;
    const target: Record<string, unknown> = pair[1]!.length && parent ? parent : data;
    if (!pair[1]!.length) parent = null;
    const value = pair[3]!.trim();
    if (!value) { const child: Record<string, unknown> = {}; target[pair[2]!] = child; if (!pair[1]!.length) parent = child; continue; }
    if (value === '>' || value === '|' || value === '>-' || value === '|-') { block = { target, key: pair[2]!, indent: pair[1]!.length, fold: value.startsWith('>'), lines: [] }; continue; }
    target[pair[2]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  flush();
  return { data, body: match[2]!.trim() };
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function parseSkill(path: string, text: string): SkillFile {
  const { data, body } = parseFrontmatter(text);
  const meta = (typeof data.metadata === 'object' && data.metadata ? data.metadata : {}) as Record<string, unknown>;
  const name = str(data.name);
  if (!name) throw new Error(`${path}: frontmatter needs a name`);
  if (!body) throw new Error(`${path}: empty body`);
  const layer = str(meta.layer) === 'business' || str(meta.business) ? 'business' : 'universal';
  const version = Number(/\d+/.exec(str(meta.version) ?? '1')?.[0] ?? 1) || 1;
  return {
    path, name, description: str(data.description) ?? '', layer, business: str(meta.business),
    title: str(meta.title) ?? (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name),
    category: str(meta.category) ?? (layer === 'universal' ? 'Procedure' : 'general'),
    version, status: (str(meta.status) ?? 'published').toLowerCase() === 'draft' ? 'draft' : 'published',
    updated: str(meta.updated), source: str(meta.source), body,
  };
}

export async function readSkillTree(root: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'SKILL.md') out.push(parseSkill(relative(root, path).split(sep).join('/'), await readFile(path, 'utf8')));
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Deterministic RFC 4122 (version 5 layout) id, so a re-import targets the same row. */
export function stableId(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Converts parsed skills into config rows for one business. Business-layer files of other businesses
 * are skipped; universal procedures and the business's assistant-settings become skills; fact sheets
 * become knowledge sources; drafts stay drafts (the AI never reads them).
 */
export function toSupportConfig(skills: SkillFile[], businessId: string, businessSlug: string, now = new Date().toISOString()): { knowledge: ImportedKnowledge[]; skills: ImportedSkill[] } {
  const knowledge: ImportedKnowledge[] = [];
  const procedures: ImportedSkill[] = [];
  for (const skill of skills) {
    const updatedAt = skill.updated && !Number.isNaN(Date.parse(skill.updated)) ? new Date(skill.updated).toISOString() : now;
    // `<slug>-assistant-settings` is loaded in every conversation (tone, approvals, allowed actions): it is
    // guidance for the model, so it becomes a skill. Skills never grant tools; policy stays in settings.
    const settings = skill.layer === 'business' && skill.name.endsWith('-assistant-settings');
    if (settings && (skill.business ?? skill.path.split('/')[0]) !== businessSlug) continue;
    if (skill.layer === 'universal' || settings) {
      procedures.push({ id: stableId(businessId, 'skill', skill.name), businessId, name: settings ? `${businessSlug}/assistant-settings` : `universal/${skill.name}`, content: `${skill.description}\n\n${skill.body}`.trim().slice(0, 20_000), revision: skill.version, enabled: skill.status === 'published', updatedAt });
      continue;
    }
    if (skill.business !== businessSlug && !skill.path.startsWith(`${businessSlug}/`)) continue;
    const source = skill.source ? `\n\nДжерело: ${skill.source}` : '';
    knowledge.push({ id: stableId(businessId, 'knowledge', skill.name), businessId, title: skill.title.slice(0, 200), category: skill.category.slice(0, 100), content: `${skill.body}${source}`.slice(0, 50_000), version: skill.version, status: skill.status, updatedAt });
  }
  return { knowledge, skills: procedures };
}
