import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConstraintDefinition } from '../src/core/migrations.js';

test('schema adoption accepts equivalent PostgreSQL dump/restore casts but rejects changed enum values', () => {
  const original = "CHECK (operation::text = ANY (ARRAY['uppercase'::character varying, 'reverse'::character varying]::text[]))";
  const restored = "CHECK (operation::text = ANY (ARRAY['uppercase'::character varying::text, 'reverse'::character varying::text]))";
  assert.equal(normalizeConstraintDefinition(original), normalizeConstraintDefinition(restored));
  assert.notEqual(normalizeConstraintDefinition(original), normalizeConstraintDefinition(restored.replace('reverse', 'delete')));
  assert.notEqual(normalizeConstraintDefinition(original), normalizeConstraintDefinition(restored.replace('= ANY', '<> ALL')));
  for (const changed of ['upper::textcase', 'upper::character varyingcase', 'upper case', 'upper(case)', "upper''case"]) {
    assert.notEqual(normalizeConstraintDefinition(original), normalizeConstraintDefinition(restored.replace('uppercase', changed)), changed);
  }
});

test('normalization preserves escaped literals, quoted identifiers and dollar-quoted values', () => {
  const escaped = "CHECK (operation::text = E'upper\\'::textcase'::text)";
  assert.equal(normalizeConstraintDefinition(escaped), "CHECK (operation = E'upper\\'::textcase')");
  assert.equal(normalizeConstraintDefinition('CHECK ("column::text"::text = $tag$upper::text case(x)$tag$::text)'), 'CHECK ("column::text" = $tag$upper::text case(x)$tag$)');
  assert.equal(normalizeConstraintDefinition("CHECK (operation::text = 'upper''::textcase'::text)"), "CHECK (operation = 'upper''::textcase')");
});
