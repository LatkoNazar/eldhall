import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { releaseManifestJsonSchema } from '../src/release/json-schema.js';

const target = new URL('../../../schemas/release-manifest.v1.schema.json', import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && args[0] !== '--check')) throw new Error('Usage: node --import tsx scripts/release-schema.ts [--check]');
const generated = releaseManifestJsonSchema();
if (args[0] === '--check') {
  if (await readFile(target, 'utf8') !== generated) throw new Error('Release JSON Schema is out of date');
  console.log('Release JSON Schema matches its source');
} else {
  await mkdir(new URL('./', target), { recursive: true });
  await writeFile(target, generated, 'utf8');
  console.log('Generated release-manifest.v1.schema.json');
}
