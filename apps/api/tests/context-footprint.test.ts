import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSupportContextAccess } from '../src/modules/agent/context-access.js';
import { parseSkillContext, type ContextSkill } from '../src/modules/agent/context.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const chars = (value: unknown) => JSON.stringify(value).length;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('measures the same public bank skill fixture eagerly and through actual bounded context loads', async t => {
  const config = JSON.parse(await readFile(new URL('../../../examples/banking/support.config.json', import.meta.url), 'utf8'));
  const skills: ContextSkill[] = config.skills.map(({ id, name, revision, content }: ContextSkill) => ({ id, name, revision, content }));
  assert.equal(skills.length, 8); // The stored private custom ninth skill is deliberately outside this fixture.
  const projected = skills.map(skill => ({ ...skill, content: parseSkillContext(skill).content.slice(0, 8000) }));
  const mandatory = projected.filter(skill => parseSkillContext(skills.find(source => source.id === skill.id)!).activation === 'always');
  assert.equal(mandatory.length, 3);
  const scenarios = [
    { name: 'one-domain', message: 'Поясніть комісію за паперову виписку.', domains: ['banking-fees-statements'] },
    { name: 'multiple-domains', message: 'Загубив картку, потрібна виписка та перевірка подвійного списання.', domains: ['banking-card-support', 'banking-fees-statements', 'banking-refunds'] },
  ];
  for (const scenario of scenarios) {
    const access = createSupportContextAccess({ skills, tools: [], messages: [], assertActive: async () => undefined });
    const eager = { message: scenario.message, skills: projected };
    const initial = { message: scenario.message, skills: mandatory, contextCatalog: access.catalog };
    const initialJson = JSON.stringify(initial);
    for (const skill of projected.filter(skill => !mandatory.includes(skill))) assert.equal(initialJson.includes(JSON.stringify(skill.content)), false, 'optional instruction bodies must not be present in the initial projection');
    const selected = scenario.domains.map(domain => skills.find(skill => skill.name === `universal/${domain}`)!);
    assert.ok(selected.every(Boolean));
    const loaded = await access.load({ skillIds: selected.map(skill => skill.id) });
    assert.deepEqual(loaded.skills.map(skill => skill.id), selected.map(skill => skill.id));
    for (const skill of loaded.skills) {
      const expected = parseSkillContext(skills.find(source => source.id === skill.id)!).content;
      assert.equal(skill.content, expected);
      assert.equal(skill.contentHash, hash(expected));
    }
    assert.equal(loaded.tools.length, 0); assert.equal(loaded.messages.length, 0);
    assert.ok(bytes(initial) < bytes(eager), 'this fixed fixture should have a smaller initial skill projection including catalog overhead');
    t.diagnostic(JSON.stringify({ scenario: scenario.name, fixtureSkills: skills.length, initialBodies: mandatory.length, loadedBodies: loaded.skills.length, eagerUtf8Bytes: bytes(eager), initialUtf8Bytes: bytes(initial), loadedReplyUtf8Bytes: bytes(loaded), initialPlusReplyUtf8Bytes: bytes(initial) + bytes(loaded), eagerUtf16Characters: chars(eager), initialUtf16Characters: chars(initial), nativeModelCalls: 0, scope: 'skill projection plus actual context-load reply only; not a complete model request or token/cost estimate' }));
  }
});
