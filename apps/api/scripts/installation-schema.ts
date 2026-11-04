import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { initRequestSchema, installationSchema } from '../src/installation/contracts.js';

const targets = [['init-request', initRequestSchema], ['installation', installationSchema]] as const;
if (process.argv.slice(2).some(value => value !== '--check') || process.argv.slice(2).length > 1) throw new Error('Expected optional --check');
for (const [name, schema] of targets) {
  const value = { ...z.toJSONSchema(schema), $id: `urn:eldhall:${name}:1`, $comment: 'Structural schema only; use the application validator for namespace, mode, literal-value and other semantic checks. Prepared/unbound local metadata is not release acceptance or resource ownership.' };
  const content = JSON.stringify(value, null, 2) + '\n';
  const path = new URL(`../../../schemas/${name}.v1.schema.json`, import.meta.url);
  if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== content) throw new Error('Installation schema artifact drift'); }
  else await writeFile(path, content);
}
