import { readFile, stat } from 'node:fs/promises';

const application = new URL('../../', import.meta.url);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const validVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && semver.test(value);

export const help = `Eldhall server CLI

Usage:
  eldhall help
  eldhall version
  eldhall config validate [--file PATH]
  eldhall release validate --file PATH
  eldhall init --directory NEW_CHILD_DIRECTORY --request-file PATH

config validate uses --file or SUPPORT_CONFIG_FILE; it does not read .env.
Validation checks static JSON contracts only. It does not connect to services,
bootstrap data, verify provider access, fetch artifacts or enforce database epochs.
API, worker and migrations keep their existing direct container commands.
init is offline Linux preparation only: private files, prepared/unbound identity,
no service startup or release/resource-ownership proof. support.env is Compose-only.

Exit codes: 0 success; 1 invalid/unreadable input; 2 invalid command arguments.
`;

async function boundedText(file: string | URL, maximum: number): Promise<string> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error('Invalid input file');
  const value = await readFile(file, 'utf8');
  if (Buffer.byteLength(value) > maximum) throw new Error('Invalid input file');
  return value;
}

export async function versionInfo(root: URL = application, metadataFile: URL = new URL('../build-info.json', import.meta.url)) {
  const packageInfo: unknown = JSON.parse(await boundedText(new URL('package.json', root), 65_536));
  if (!packageInfo || typeof packageInfo !== 'object' || !('version' in packageInfo) || !validVersion(packageInfo.version)) throw new Error('Invalid package identity');
  let version = packageInfo.version;
  let sourceRevision: string | null = null;
  let metadata: unknown;
  let unreadableMetadata = false;
  try { metadata = JSON.parse(await boundedText(metadataFile, 4096)); }
  catch (error) {
    unreadableMetadata = !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }
  if (unreadableMetadata) throw new Error('Invalid build identity');
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).sort().join() !== 'sourceRevision,version'
      || !('version' in metadata) || !validVersion(metadata.version) || !('sourceRevision' in metadata)
      || !(metadata.sourceRevision === null || (typeof metadata.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(metadata.sourceRevision)))) throw new Error('Invalid build identity');
    version = metadata.version;
    sourceRevision = metadata.sourceRevision;
  }
  return { name: 'eldhall', version, packageVersion: packageInfo.version, sourceRevision, buildMetadata: sourceRevision === null ? 'unrecorded' : 'recorded' };
}

type Output = { stdout: (value: string) => void; stderr: (value: string) => void };

export async function runCli(args: string[], output: Output, environment: Record<string, string | undefined> = process.env): Promise<number> {
  const usage = () => { output.stderr('Invalid command arguments. Run eldhall help.'); return 2; };
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!))) { output.stdout(help); return 0; }
  if (args.length === 1 && ['version', '--version'].includes(args[0]!)) {
    try { output.stdout(JSON.stringify(await versionInfo())); return 0; }
    catch { output.stderr('Build identity is invalid or unreadable.'); return 1; }
  }
  if (args[0] === 'init') {
    if (args.length !== 5) return usage();
    const options: Record<string, string> = {};
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index]!, value = args[index + 1]!;
      if (!['--directory', '--request-file'].includes(name) || Object.hasOwn(options, name) || !value || value.startsWith('--')) return usage();
      options[name] = value;
    }
    if (!options['--directory'] || !options['--request-file']) return usage();
    try {
      const { loadInitRequest, prepareInstallation, InstallationFailure } = await import('../installation/prepare.js');
      const { initializeOffline } = await import('../installation/filesystem.js');
      try {
        const request = await loadInitRequest(options['--request-file']);
        const build = await versionInfo();
        const prepared = await prepareInstallation(request, { version: build.version, packageVersion: build.packageVersion, sourceRevision: build.sourceRevision }, environment);
        const result = await initializeOffline(options['--directory'], prepared);
        output.stdout(JSON.stringify({ status: result.status, state: 'prepared', releaseBinding: 'unbound', files: ['support.env', 'support.json', 'installation.json'] }));
        return 0;
      } catch (error) {
        output.stderr(`Offline preparation refused: ${error instanceof InstallationFailure ? error.reason : 'invalid_request'}.`);
        return 1;
      }
    } catch { output.stderr('Offline preparation is unavailable.'); return 1; }
  }
  if (!['config', 'release'].includes(args[0] ?? '') || args[1] !== 'validate') return usage();
  let file: string | undefined;
  if (args.length === 4 && args[2] === '--file' && args[3] && !args[3].startsWith('--')) file = args[3];
  else if (args.length === 2 && args[0] === 'config') file = environment.SUPPORT_CONFIG_FILE;
  else return usage();
  if (!file?.trim() || file.length > 4096) return usage();
  if (args[0] === 'config') {
    try {
      // This loader validates static structure/hashes; no factory, credentials,
      // connector readiness, database bootstrap or remote request is invoked.
      const { loadSupportConfig } = await import('../integrations/config.js');
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size > 2_000_000) throw new Error('Invalid input file');
      await loadSupportConfig(file);
      output.stdout(JSON.stringify({ valid: true, kind: 'support-config', scope: 'static' }));
      return 0;
    } catch { output.stderr('Support configuration is invalid or unreadable.'); return 1; }
  }
  try {
    const { parseReleaseManifest } = await import('../release/parse.js');
    parseReleaseManifest(await boundedText(file, 4_000_000));
    output.stdout(JSON.stringify({ valid: true, kind: 'release-manifest', scope: 'static' }));
    return 0;
  } catch { output.stderr('Release manifest is invalid or unreadable.'); return 1; }
}
