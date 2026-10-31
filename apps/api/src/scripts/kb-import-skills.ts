// Imports a SKILL.md knowledge pack into a support config file (SUPPORT_CONFIG_FILE).
//
//   npx tsx src/scripts/kb-import-skills.ts <skills-root> <business-slug> <config.json> [--write]
//
// Universal procedures become skills, the business's fact sheets become knowledge sources. Rows
// with the same derived id are replaced, everything else in the config is kept. Without --write the
// merged config is printed, so the diff can be reviewed first. The config bootstrap then applies a
// row only when its version (knowledge) or revision (skill) is higher than the stored one.
import { readFile, writeFile } from 'node:fs/promises';
import { readSkillTree, toSupportConfig } from '../modules/knowledge/skill-md.js';

async function main() {
  const [root, slug, configPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (!root || !slug || !configPath) throw new Error('Usage: kb-import-skills <skills-root> <business-slug> <config.json> [--write]');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { businesses: { id: string; slug: string }[]; knowledge?: { id: string }[]; skills?: { id: string }[] };
  const business = config.businesses.find(b => b.slug === slug);
  if (!business) throw new Error(`Business "${slug}" is not in ${configPath}`);
  const imported = toSupportConfig(await readSkillTree(root), business.id, slug);
  const replace = <T extends { id: string }>(rows: T[] | undefined, next: T[]) => [...(rows ?? []).filter(row => !next.some(n => n.id === row.id)), ...next];
  const merged = { ...config, knowledge: replace(config.knowledge, imported.knowledge), skills: replace(config.skills, imported.skills) };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (process.argv.includes('--write')) await writeFile(configPath, text);
  else process.stdout.write(text);
  console.error(`kb-import-skills: ${imported.knowledge.length} knowledge sources, ${imported.skills.length} skills for ${slug}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
