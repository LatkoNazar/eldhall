import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { installationSchema, type Installation } from './contracts.js';
import { decodeGeneratedEnvironment, encodeComposeEnvironment, literalValue } from './env.js';
import { InstallationFailure, renderEnvironment, type PreparedInstallation } from './prepare.js';
import { parseInstallationJson } from './json.js';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const anchored = (handle: FileHandle, name = '') => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}`;
const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;
function privateMode(metadata: BigIntStats, mode: bigint) {
  if (!process.geteuid || metadata.uid !== BigInt(process.geteuid()) || (metadata.mode & 0o7777n) !== mode) throw new InstallationFailure('private_permissions_required');
}
async function openParent(destination: string): Promise<FileHandle> {
  let current = await open('/', directoryFlags);
  try {
    for (const part of dirname(destination).split('/').filter(Boolean)) {
      const next = await open(anchored(current, part), directoryFlags);
      await current.close();
      current = next;
    }
    return current;
  } catch {
    await current.close();
    throw new InstallationFailure('unsafe_path');
  }
}
async function readPrivate(directory: FileHandle, name: string, maximum: number): Promise<string> {
  const handle = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat({ bigint: true });
    privateMode(metadata, 0o600n);
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > BigInt(maximum)) throw new InstallationFailure('incomplete_or_conflicting_installation');
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > maximum) throw new InstallationFailure('incomplete_or_conflicting_installation');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}
async function writePrivate(directory: FileHandle, name: string, value: string) {
  const handle = await open(anchored(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600); // Only this just-created file; never existing state.
    privateMode(await handle.stat({ bigint: true }), 0o600n);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}
function serviceKeys(values: Record<string, string>, database: 'bundled' | 'external') {
  const required = ['API_TOKEN', 'OPERATOR_TOKEN', 'REDIS_PASSWORD', ...(database === 'bundled' ? ['POSTGRES_PASSWORD'] : [])];
  if (required.some(key => !/^[a-f0-9]{64}$/.test(values[key] ?? ''))) throw new InstallationFailure('incomplete_or_conflicting_installation');
  return { API_TOKEN: values.API_TOKEN!, OPERATOR_TOKEN: values.OPERATOR_TOKEN!, REDIS_PASSWORD: values.REDIS_PASSWORD!,
    ...(database === 'bundled' ? { POSTGRES_PASSWORD: values.POSTGRES_PASSWORD! } : {}) };
}
async function reuse(directory: FileHandle, prepared: PreparedInstallation): Promise<Installation> {
  try {
    const names = await readdir(anchored(directory));
    if (names.sort().join() !== 'installation.json,support.env,support.json') throw new InstallationFailure('incomplete_or_conflicting_installation');
    const identity = installationSchema.parse(parseInstallationJson(await readPrivate(directory, 'installation.json', 16_384)));
    if (JSON.stringify(identity.intent) !== JSON.stringify(prepared.identity.intent)) throw new InstallationFailure('incomplete_or_conflicting_installation');
    const environment = await readPrivate(directory, 'support.env', 65_536);
    const values = decodeGeneratedEnvironment(environment);
    const expected = renderEnvironment({ ...prepared, identity }, serviceKeys(values, prepared.request.database.mode));
    if (encodeComposeEnvironment(expected) !== environment || await readPrivate(directory, 'support.json', 4096) !== prepared.support) throw new InstallationFailure('incomplete_or_conflicting_installation');
    return identity;
  } catch { throw new InstallationFailure('incomplete_or_conflicting_installation'); }
}
async function initialize(destination: string, prepared: PreparedInstallation) {
  const parent = await openParent(destination);
  let directory: FileHandle | undefined;
  try {
    const name = basename(destination);
    let created = false;
    try { await mkdir(anchored(parent, name), { mode: 0o700 }); created = true; }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    directory = await open(anchored(parent, name), directoryFlags);
    const metadata = await directory.stat({ bigint: true });
    privateMode(await directory.stat({ bigint: true }), 0o700n);
    const checkBinding = async () => {
      const current = await lstat(anchored(parent, name), { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, metadata)) throw new InstallationFailure('unsafe_path');
      const currentParent = await openParent(destination);
      try { if (!same(await parent.stat({ bigint: true }), await currentParent.stat({ bigint: true }))) throw new InstallationFailure('unsafe_path'); }
      finally { await currentParent.close(); }
    };
    await checkBinding();
    if (!created) {
      const identity = await reuse(directory, prepared);
      await checkBinding();
      return { status: 'reused' as const, identity };
    }
    await writePrivate(directory, 'support.env', prepared.environment);
    await checkBinding();
    await writePrivate(directory, 'support.json', prepared.support);
    await checkBinding();
    // Commit marker last. A crash/failure before or during this write leaves
    // an incomplete private directory, which later init refuses without repair.
    await writePrivate(directory, 'installation.json', JSON.stringify(prepared.identity, null, 2) + '\n');
    await directory.sync();
    await parent.sync();
    await checkBinding();
    return { status: 'created' as const, identity: prepared.identity };
  } finally { await directory?.close(); await parent.close(); }
}
/** Offline local preparation only; never opens a DB, service or Docker socket. */
export async function initializeOffline(directory: string, prepared: PreparedInstallation) {
  if (process.platform !== 'linux') throw new InstallationFailure('unsupported_private_filesystem');
  if (!directory || directory.length > 4096 || !literalValue(directory) || directory.split(/[\\/]/).includes('..')) throw new InstallationFailure('unsafe_path');
  const destination = resolve(directory);
  if (destination === sep) throw new InstallationFailure('unsafe_path');
  try { return await initialize(destination, prepared); }
  catch (error) { if (error instanceof InstallationFailure) throw error; }
  // Never expose raw filesystem paths, input values or parser errors.
  throw new InstallationFailure('filesystem_unavailable');
}
