// Create a fail-closed support config for a previously provisioned business.
// Build apps/api first; use the same runtime validator as API and worker.
import { readFile, writeFile } from 'node:fs/promises';
import { supportConfigSchema } from '../apps/api/dist/integrations/config.js';
import { fingerprint } from '../apps/api/dist/integrations/permissions.js';

const names = new Set(['--manifest', '--business-id', '--url', '--credential-env', '--out', '--connection-revision', '--upstream-url', '--upstream-principal']);
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]; const value = process.argv[i + 1];
  if (!names.has(name) || !value || value.startsWith('--') || Object.hasOwn(args, name)) throw new Error('Expected unique --manifest, --business-id, --url, --credential-env, --out and optional --connection-revision');
  args[name] = value;
}
for (const name of ['--manifest', '--business-id', '--url', '--credential-env', '--out', '--upstream-url']) if (!args[name]) throw new Error(`Missing ${name}`);
const upstream = new URL(args['--upstream-url']);
if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Upstream URL requires http(s) without credentials, query or fragment');
const principalId = args['--upstream-principal'] ?? 'default';
if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(principalId)) throw new Error('Invalid upstream principal label');
const manifest = JSON.parse(await readFile(args['--manifest'], 'utf8'));
const config = supportConfigSchema.parse({ catalogs: [{
  businessId: args['--business-id'], url: args['--url'], credentialEnv: args['--credential-env'],
  connectionRevision: args['--connection-revision'] ?? '1', manifest,
  upstreamTargetFingerprint: fingerprint({ baseUrl: upstream.href.replace(/\/+$/, ''), principalId }),
  policy: {
    integrationId: manifest.integrationId, businessId: args['--business-id'], enabled: false,
    manifestHash: manifest.manifestHash, policyRevision: 1, defaultMode: 'deny', groups: [],
    operations: manifest.operations.map(op => ({ operationKey: op.operationKey, enabled: false, reviewedOperationHash: null, mode: 'inherit' })),
  },
}] });
await writeFile(args['--out'], JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Support config created. Provision the business, mount the config in API and worker, then review and activate through the operator API. All operations start disabled.');
