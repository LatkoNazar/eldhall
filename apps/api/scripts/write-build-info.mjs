// Build-time only. The CLI reads the resulting file, never these environment names.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 4 && args[0] === '--version' && args[2] === '--source-revision')) throw new Error();
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = args[1] || packageInfo.version;
  const sourceRevision = args[3] || null;
  if (typeof version !== 'string' || version.length > 128 || !versionPattern.test(version)
    || !(sourceRevision === null || /^[a-f0-9]{40}$/.test(sourceRevision))) throw new Error();
  const directory = new URL('../dist/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL('build-info.json', directory), JSON.stringify({ version, sourceRevision }) + '\n');
} catch {
  console.error('Invalid public build metadata; expected a semantic version and an empty or full lowercase source revision.');
  process.exitCode = 1;
}
