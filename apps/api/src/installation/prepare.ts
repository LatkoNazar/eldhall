import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { settingsFrom } from '../core/config.js';
import { supportConfigSchema } from '../integrations/config.js';
import { initRequestSchema, installationSchema, plannedResources, preparedBySchema, type InitRequest, type Installation, type PreparedBy } from './contracts.js';
import { encodeComposeEnvironment, literalValue } from './env.js';
import { parseInstallationJson } from './json.js';

export class InstallationFailure extends Error {
  constructor(readonly reason: 'invalid_request' | 'invalid_input_source' | 'unsupported_private_filesystem' | 'unsafe_path' | 'incomplete_or_conflicting_installation' | 'private_permissions_required' | 'filesystem_unavailable') { super(reason); }
}
export async function readBoundedFile(file: string, maximum: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new InstallationFailure('invalid_input_source');
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximum) throw new InstallationFailure('invalid_input_source');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}
export async function loadInitRequest(file: string): Promise<InitRequest> {
  try { return initRequestSchema.parse(parseInstallationJson(await readBoundedFile(file, 65_536))); }
  catch { throw new InstallationFailure('invalid_request'); }
}
type ServiceKeys = { API_TOKEN: string; OPERATOR_TOKEN: string; REDIS_PASSWORD: string; POSTGRES_PASSWORD?: string };
export type PreparedInstallation = { request: InitRequest; identity: Installation; providerKey?: string; databaseUrl?: string; values: Record<string, string>; environment: string; support: string };
async function resolveSource(source: { file: string } | { env: string }, environment: Record<string, string | undefined>): Promise<string> {
  let value: string | undefined;
  try { value = 'file' in source ? await readBoundedFile(source.file, 16_384) : environment[source.env]; }
  catch { throw new InstallationFailure('invalid_input_source'); }
  // Credentials have exact literal semantics. A newline is unsupported, even
  // when a secret-file writer inserted it; never silently trim a credential.
  if (!value || !literalValue(value)) throw new InstallationFailure('invalid_input_source');
  return value;
}
function publicProvider(request: InitRequest): Installation['intent']['provider'] {
  const provider = request.provider;
  if (provider.id === 'rules') return { id: 'rules', keyConfigured: false };
  if (provider.id === 'local') return { id: 'local', model: provider.model, baseUrl: provider.baseUrl, keyConfigured: !!provider.key };
  return { id: provider.id, model: provider.model, keyConfigured: true };
}
export function renderEnvironment(prepared: Pick<PreparedInstallation, 'request' | 'identity' | 'providerKey' | 'databaseUrl'>, keys: ServiceKeys): Record<string, string> {
  const { request, identity } = prepared;
  const values: Record<string, string> = { ENVIRONMENT: 'production', PROJECT_NAME: identity.projectName, SUPPORT_STORE: 'postgres', SUPPORT_EXECUTION: 'worker', DEMO_RESET_ENABLED: 'false',
    REDIS_HOST: 'redis', REDIS_PORT: '6379', REDIS_PASSWORD: keys.REDIS_PASSWORD, API_TOKEN: keys.API_TOKEN, OPERATOR_TOKEN: keys.OPERATOR_TOKEN,
    BULLMQ_DB: '2', BULLMQ_PREFIX: identity.plannedResources.queue.prefix, BULLMQ_QUEUE: identity.plannedResources.queue.jobsQueue,
    RUNTIME_HOME: '/data/dsh', SUPPORT_CONFIG_FILE: '/config/support.json', SUPPORT_CONFIG_PATH: './support.json',
    ALLOWED_HOSTS: '["localhost","127.0.0.1"]', CORS_ORIGINS: '[]', LLM_PROVIDER: request.provider.id, AGENT_RUNTIME: request.provider.id === 'rules' ? 'rules' : 'dsh' };
  if (request.database.mode === 'bundled') Object.assign(values, { POSTGRES_HOST: 'postgres', POSTGRES_PORT: '5432', POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: keys.POSTGRES_PASSWORD ?? '' });
  else values.DATABASE_URL = prepared.databaseUrl ?? '';
  if (request.provider.id !== 'rules') {
    values.LLM_MODEL = request.provider.model;
    const names = { google: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', local: 'LOCAL_MODEL_API_KEY' };
    if (prepared.providerKey !== undefined) values[names[request.provider.id]] = prepared.providerKey;
    if (request.provider.id === 'local') values.LLM_BASE_URL = request.provider.baseUrl;
  }
  // Pure settings validation with this exact map, never ambient environment.
  settingsFrom(values);
  return values;
}
export async function prepareInstallation(input: unknown, preparedBy: PreparedBy, environment: Record<string, string | undefined> = process.env): Promise<PreparedInstallation> {
  let request: InitRequest;
  try { request = initRequestSchema.parse(input); preparedBySchema.parse(preparedBy); } catch { throw new InstallationFailure('invalid_request'); }
  const providerKey = request.provider.id !== 'rules' && request.provider.key ? await resolveSource(request.provider.key, environment) : undefined;
  const databaseUrl = request.database.mode === 'external' ? await resolveSource(request.database.url, environment) : undefined;
  if (databaseUrl !== undefined && databaseUrl !== databaseUrl.trim()) throw new InstallationFailure('invalid_input_source');
  const installationId = randomUUID(), resources = plannedResources(installationId, request.project, request.database.mode);
  const identity = installationSchema.parse({ installationFormat: 1, installationId, projectName: resources.composeProject, state: 'prepared', releaseBinding: { status: 'unbound', manifest: null },
    intent: { project: request.project, mode: request.mode, database: { mode: request.database.mode }, provider: publicProvider(request) }, plannedResources: resources,
    files: { environment: 'support.env', supportConfig: 'support.json' }, preparedBy });
  const key = () => randomBytes(32).toString('hex');
  const keys: ServiceKeys = { API_TOKEN: key(), OPERATOR_TOKEN: key(), REDIS_PASSWORD: key(), ...(request.database.mode === 'bundled' ? { POSTGRES_PASSWORD: key() } : {}) };
  let values: Record<string, string>;
  try { values = renderEnvironment({ request, identity, ...(providerKey !== undefined ? { providerKey } : {}), ...(databaseUrl !== undefined ? { databaseUrl } : {}) }, keys); }
  catch { throw new InstallationFailure('invalid_request'); }
  const support = JSON.stringify(supportConfigSchema.parse({ version: 1 }), null, 2) + '\n';
  return { request, identity, values, environment: encodeComposeEnvironment(values), support, ...(providerKey !== undefined ? { providerKey } : {}), ...(databaseUrl !== undefined ? { databaseUrl } : {}) };
}
