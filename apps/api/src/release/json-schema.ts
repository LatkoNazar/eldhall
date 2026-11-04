import { z } from 'zod';
import { releaseManifestStructure } from './manifest.js';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)]));
  return value;
}

/** Structural JSON Schema only; cross-field validation requires releaseManifestSchema. */
export function releaseManifestJsonSchema(): string {
  const schema = z.toJSONSchema(releaseManifestStructure, { target: 'draft-2020-12' });
  return `${JSON.stringify(sorted({ ...schema, $id: 'https://eldhall.com/schemas/release-manifest.v1.schema.json', title: 'Eldhall release manifest v1', description: 'Structural schema. Also run the Eldhall semantic validator for digest, compatibility, source and verification consistency.', 'x-eldhall-semantic-validator': 'apps/api/src/release/manifest.ts#releaseManifestSchema' }), null, 2)}\n`;
}
