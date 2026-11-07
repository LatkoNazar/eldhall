import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkill, toSupportConfig } from '../src/modules/knowledge/skill-md.js';
import { parseSkillContext } from '../src/modules/agent/context.js';

const business = 'b1000000-0000-4000-8000-000000000001';
const body = '# Procedure\nNever fabricate an action. Preserve every instruction.';
const source = (metadata: string) => `---\nname: example-procedure\ndescription: Handle a scoped example.\n${metadata}metadata:\n  layer: universal\n  version: 2\n---\n\n${body}`;
const imported = (text: string) => toSupportConfig([parseSkill('universal/example-procedure/SKILL.md', text)], business, 'bank').skills[0]!;

test('explicit recognized activation survives import without changing stable IDs or instruction bodies', () => {
  const legacy = imported(source(''));
  const lazy = imported(source('activation: on_demand\n'));
  assert.equal(lazy.id, legacy.id); assert.equal(lazy.revision, 2);
  assert.equal(legacy.content, `Handle a scoped example.\n\n${body}`);
  assert.deepEqual(parseSkillContext(lazy), { activation: 'on_demand', purpose: 'Handle a scoped example.', content: legacy.content });
  assert.equal(parseSkillContext(imported(source('activation: always\n'))).activation, 'always');
});

test('unknown, duplicate and malformed activation stay mandatory and retain the complete legacy instructions', () => {
  const legacy = imported(source(''));
  for (const header of ['activation: optional\n', 'activation: on_demand\nactivation: always\n', 'activation: on_demand\ndescription: duplicate description\n']) {
    const row = imported(source(header));
    assert.equal(parseSkillContext(row).activation, 'always');
    assert.ok(row.content.endsWith(body));
  }
  assert.equal(imported(source('activation: optional\n')).content, legacy.content);
  const long = imported(source('activation: on_demand\n').replace('Handle a scoped example.', 'x'.repeat(241)));
  assert.equal(parseSkillContext(long).activation, 'always');
  assert.ok(long.content.endsWith(body));
});

test('opt-in metadata cannot silently truncate an otherwise retained procedure', () => {
  const text = source('activation: on_demand\n').replace(body, 'x'.repeat(19_950));
  assert.throws(() => imported(text), /content limit/);
});
