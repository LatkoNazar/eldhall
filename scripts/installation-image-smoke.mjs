// CI-only stdin helper. Never copied into the production application context.
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireProof = value => { if (!value) throw new Error('Offline image proof failed'); };
let root;
try {
  requireProof(process.platform === 'linux' && process.getuid?.() === 1000 && process.geteuid?.() === 1000);
  const { decodeGeneratedEnvironment } = await import('/app/dist/installation/env.js');
  root = await mkdtemp(join(tmpdir(), 'eldhall-offline-image-'));
  await chmod(root, 0o700);
  const ambient = { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-ambient-never-selected', DATABASE_URL: 'synthetic-ambient-never-selected' };
  const invoke = args => {
    const result = spawnSync('eldhall', args, { env: ambient, encoding: 'utf8', timeout: 20_000, maxBuffer: 65_536 });
    requireProof(result.status === 0 && !result.error && result.stderr === '');
    return JSON.parse(result.stdout);
  };
  const version = invoke(['version']);
  const request = { initRequestFormat: 1, project: 'image-proof', mode: 'evaluation', database: { mode: 'bundled' }, provider: { id: 'rules' } };
  const requestFile = join(root, 'request.json');
  await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
  const destination = join(root, 'new-child');
  const args = ['init', '--directory', destination, '--request-file', requestFile];
  const expected = status => ({ status, state: 'prepared', releaseBinding: 'unbound', files: ['support.env', 'support.json', 'installation.json'] });
  requireProof(JSON.stringify(invoke(args)) === JSON.stringify(expected('created')));
  const snapshot = async directory => {
    const metadata = await lstat(directory);
    requireProof(metadata.isDirectory() && metadata.uid === 1000 && (metadata.mode & 0o7777) === 0o700);
    const names = (await readdir(directory)).sort();
    requireProof(names.join() === 'installation.json,support.env,support.json');
    const result = {};
    for (const name of names) {
      const file = join(directory, name), stat = await lstat(file);
      requireProof(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 1000 && (stat.mode & 0o7777) === 0o600);
      result[name] = { bytes: await readFile(file, 'utf8'), modified: stat.mtimeMs };
    }
    return result;
  };
  const before = await snapshot(destination);
  const identity = JSON.parse(before['installation.json'].bytes);
  requireProof(identity.installationFormat === 1 && identity.state === 'prepared' && identity.releaseBinding.status === 'unbound' && identity.releaseBinding.manifest === null);
  requireProof(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.installationId) && !('databaseEpoch' in identity) && !('schemaEpoch' in identity));
  const hex = identity.installationId.replaceAll('-', ''), project = `eldhall-image-proof-${hex}`;
  requireProof(identity.projectName === project && identity.plannedResources.composeProject === project && identity.plannedResources.queue.prefix === `eldhall_${hex}`);
  requireProof(identity.preparedBy.version === version.version && identity.preparedBy.packageVersion === version.packageVersion && identity.preparedBy.sourceRevision === version.sourceRevision);
  const values = decodeGeneratedEnvironment(before['support.env'].bytes);
  for (const name of ['API_TOKEN', 'OPERATOR_TOKEN', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']) requireProof(/^[a-f0-9]{64}$/.test(values[name]));
  requireProof(values.SUPPORT_STORE === 'postgres' && values.SUPPORT_EXECUTION === 'worker' && values.DEMO_RESET_ENABLED === 'false');
  requireProof(values.PROJECT_NAME === project && values.BULLMQ_PREFIX === identity.plannedResources.queue.prefix && values.BULLMQ_DB === '2');
  requireProof(!('OPENAI_API_KEY' in values) && !('DATABASE_URL' in values));
  const support = JSON.parse(before['support.json'].bytes);
  for (const name of ['businesses', 'knowledge', 'skills', 'integrations', 'catalogs']) requireProof(Array.isArray(support[name]) && support[name].length === 0);
  requireProof(JSON.stringify(invoke(args)) === JSON.stringify(expected('reused')));
  requireProof(JSON.stringify(await snapshot(destination)) === JSON.stringify(before));

  // Explicit sources use only synthetic values, without any network/provider/DB.
  const providerKey = 'synthetic-key-$#both\'"quotes\\Привіт';
  const databaseUrl = 'postgresql://synthetic:p%24%23%27%22@unreachable.invalid:5432/app?sslmode=verify-full';
  const providerFile = join(root, 'provider-key'), databaseFile = join(root, 'database-url');
  await writeFile(providerFile, providerKey, { mode: 0o600 }); await writeFile(databaseFile, databaseUrl, { mode: 0o600 });
  const production = { ...request, mode: 'production', provider: { id: 'openai', model: 'synthetic-explicit-model', key: { file: providerFile } }, database: { mode: 'external', url: { file: databaseFile } } };
  await writeFile(requestFile, JSON.stringify(production));
  const external = join(root, 'external-child');
  requireProof(JSON.stringify(invoke(['init', '--directory', external, '--request-file', requestFile])) === JSON.stringify(expected('created')));
  const externalFiles = await snapshot(external), externalValues = decodeGeneratedEnvironment(externalFiles['support.env'].bytes);
  requireProof(externalValues.OPENAI_API_KEY === providerKey && externalValues.DATABASE_URL === databaseUrl && !('POSTGRES_PASSWORD' in externalValues));
  requireProof(!externalFiles['installation.json'].bytes.includes(providerKey) && !externalFiles['installation.json'].bytes.includes(databaseUrl));
  requireProof(JSON.parse(externalFiles['installation.json'].bytes).plannedResources.postgresVolume === null);
  await rm(root, { recursive: true }); root = undefined;
  process.stdout.write(JSON.stringify({ valid: true, proof: 'offline-image-init', uid: 1000, state: 'prepared', releaseBinding: 'unbound', privateModes: true, replayUnchanged: true, explicitSources: true, network: 'none-required-by-runner' }) + '\n');
} catch {
  if (root) { try { await rm(root, { recursive: true }); } catch { /* Report only the constant proof failure. */ } }
  process.stderr.write('Offline installation image proof failed.\n');
  process.exitCode = 1;
}
