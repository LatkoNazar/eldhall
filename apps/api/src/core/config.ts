import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { isExampleToken } from './auth.js';

export interface Settings {
  environment: 'development' | 'production';
  databaseUrl: string;
  postgresHost: string;
  postgresPort: number;
  postgresDb: string;
  postgresUser: string;
  postgresPassword: string;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  bullmqDb: number;
  bullmqPrefix: string;
  bullmqQueue: string;
  bullmqAttempts: number;
  bullmqBackoffMs: number;
  bullmqRetentionCount: number;
  bullmqCompletedRetentionSeconds: number;
  bullmqFailedRetentionSeconds: number;
  apiToken: string;
  allowedHosts: string[];
  corsOrigins: string[];
  workerConcurrency: number;
  operatorToken: string;
  supportStore: 'memory' | 'postgres';
  llmProvider: 'openai' | 'google' | 'anthropic' | 'local' | 'rules';
  llmModel: string;
  llmApiKey: string;
  llmTimeoutMs: number;
  demoResetEnabled: boolean;
  agentRuntime: 'dsh' | 'rules';
  runtimeHome: string;
  llmBaseUrl: string;
  maxRuntimeToolCalls: number;
  supportConfigFile: string;
  supportWorkspaceBusinessId?: string;
  supportExecution: 'inline' | 'worker';
  classificationProvider: 'agent' | 'openrouter';
  classificationModel: string;
  classificationApiKey: string;
  classificationTimeoutMs: number;
  knowledgeEmbeddingsProvider: 'local' | 'openai' | 'google';
  knowledgeEmbeddingsModel: string;
  knowledgeEmbeddingsApiKey: string;
  knowledgeUrlAllowlist: string[];
}

export function environmentFiles(cwd = process.cwd()): string[] {
  let directory = resolve(cwd);
  while (!existsSync(join(directory, 'compose.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory) return [join(cwd, '.env')];
    directory = parent;
  }
  return [...new Set([join(directory, '.env'), join(cwd, '.env')])];
}

export function loadEnvironment(cwd = process.cwd(), env = process.env): NodeJS.ProcessEnv {
  let files: NodeJS.ProcessEnv = {};
  for (const file of environmentFiles(cwd)) {
    if (existsSync(file)) files = { ...files, ...parseEnv(readFileSync(file, 'utf8')) };
  }
  return { ...files, ...env };
}

export function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  const value = (name: string, fallback: string) => env[name] ?? fallback;
  const integer = (name: string, fallback: string, maximum = 65535): number => {
    const raw = value(name, fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum) {
      throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
    }
    return Number(raw);
  };
  const array = (name: string, fallback: string): string[] => {
    let parsed: unknown;
    try { parsed = JSON.parse(value(name, fallback)); } catch { throw new Error(`${name} must be a JSON array of strings`); }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error(`${name} must be a JSON array of strings`);
    }
    return parsed as string[];
  };
  const environment = value('ENVIRONMENT', 'development');
  const provider = value('LLM_PROVIDER', 'rules');
  const supportStore = value('SUPPORT_STORE', 'memory');
  // Compose forwards unset variables as empty strings; treat those as unset.
  const agentRuntime = value('AGENT_RUNTIME', '') || (provider === 'rules' ? 'rules' : 'dsh');
  const databaseUrl = value('DATABASE_URL', '').trim();
  if (databaseUrl) {
    try {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash
        || /\s/.test(databaseUrl) || (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) throw new Error();
      // Catch malformed percent-encoding before the driver parses credentials.
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      decodeURIComponent(url.hostname);
      decodeURIComponent(url.pathname);
    } catch {
      // Never attach the parsing error: it can contain the credential-bearing URL.
      throw new Error('DATABASE_URL must be a valid postgres:// or postgresql:// URL with a host and database');
    }
  }
  if (environment !== 'development' && environment !== 'production') {
    throw new Error('ENVIRONMENT must be development or production');
  }
  const settings: Settings = {
    environment,
    databaseUrl,
    postgresHost: value('POSTGRES_HOST', 'postgres'),
    postgresPort: databaseUrl ? 5432 : integer('POSTGRES_PORT', '5432'),
    postgresDb: value('POSTGRES_DB', 'app'),
    postgresUser: value('POSTGRES_USER', 'app'),
    postgresPassword: value('POSTGRES_PASSWORD', 'development-only'),
    redisHost: value('REDIS_HOST', 'redis'),
    redisPort: integer('REDIS_PORT', '6379'),
    redisPassword: value('REDIS_PASSWORD', 'development-only'),
    bullmqDb: integer('BULLMQ_DB', '2', 15),
    bullmqPrefix: value('BULLMQ_PREFIX', 'node-bullmq'),
    bullmqQueue: value('BULLMQ_QUEUE', 'jobs-transform-v1'),
    bullmqAttempts: integer('BULLMQ_ATTEMPTS', '4', 10),
    bullmqBackoffMs: integer('BULLMQ_BACKOFF_MS', '1000', 60000),
    bullmqRetentionCount: integer('BULLMQ_RETENTION_COUNT', '1000', 100000),
    bullmqCompletedRetentionSeconds: integer('BULLMQ_COMPLETED_RETENTION_SECONDS', '3600', 31536000),
    bullmqFailedRetentionSeconds: integer('BULLMQ_FAILED_RETENTION_SECONDS', '86400', 31536000),
    apiToken: value('API_TOKEN', ''),
    allowedHosts: array('ALLOWED_HOSTS', '["localhost","127.0.0.1","testserver"]'),
    corsOrigins: array('CORS_ORIGINS', '[]'),
    workerConcurrency: integer('WORKER_CONCURRENCY', '2', 64),
    operatorToken: value('OPERATOR_TOKEN', ''),
    supportStore: supportStore as Settings['supportStore'],
    llmProvider: provider as Settings['llmProvider'],
    llmModel: value('LLM_MODEL', provider === 'google' ? 'gemini-3.5-flash-lite' : ''),
    // .env values are not copied into process.env, so the key is passed to the provider explicitly.
    llmApiKey: provider === 'google' ? value('GEMINI_API_KEY', '') || value('GOOGLE_GENERATIVE_AI_API_KEY', '') : value({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', local: 'LOCAL_MODEL_API_KEY', rules: '' }[provider] ?? '', ''),
    llmTimeoutMs: integer('LLM_TIMEOUT_MS', '20000', 120000),
    demoResetEnabled: (env.DEMO_RESET_ENABLED || (environment === 'development' ? 'true' : 'false')) === 'true',
    agentRuntime: agentRuntime as Settings['agentRuntime'],
    runtimeHome: value('RUNTIME_HOME', join(tmpdir(), 'support-dsh')),
    llmBaseUrl: value('LLM_BASE_URL', ''),
    maxRuntimeToolCalls: integer('MAX_RUNTIME_TOOL_CALLS', '8', 32),
    supportConfigFile: value('SUPPORT_CONFIG_FILE', ''),
    supportWorkspaceBusinessId: value('SUPPORT_WORKSPACE_BUSINESS_ID', '').trim(),
    supportExecution: value('SUPPORT_EXECUTION', supportStore === 'memory' ? 'inline' : 'worker') as Settings['supportExecution'],
    classificationProvider: value('CLASSIFICATION_PROVIDER', 'agent') as Settings['classificationProvider'],
    classificationModel: value('CLASSIFICATION_MODEL', '').trim(),
    classificationApiKey: value('OPENROUTER_API_KEY', ''),
    classificationTimeoutMs: integer('CLASSIFICATION_TIMEOUT_MS', '10000', 120000),
    knowledgeEmbeddingsProvider: value('KB_EMBEDDINGS_PROVIDER', 'local') as Settings['knowledgeEmbeddingsProvider'],
    knowledgeEmbeddingsModel: value('KB_EMBEDDINGS_MODEL', '').trim(),
    knowledgeEmbeddingsApiKey: value('KB_EMBEDDINGS_PROVIDER', 'local') === 'openai' ? value('OPENAI_API_KEY', '') : value('KB_EMBEDDINGS_PROVIDER', 'local') === 'google' ? value('GEMINI_API_KEY', '') || value('GOOGLE_GENERATIVE_AI_API_KEY', '') : '',
    knowledgeUrlAllowlist: array('KB_URL_ALLOWLIST', '[]'),
  };
  if (!['memory', 'postgres'].includes(settings.supportStore)) throw new Error('SUPPORT_STORE must be memory or postgres');
  if (settings.supportWorkspaceBusinessId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(settings.supportWorkspaceBusinessId)) throw new Error('SUPPORT_WORKSPACE_BUSINESS_ID must be a UUID');
  if (!['openai', 'google', 'anthropic', 'local', 'rules'].includes(settings.llmProvider)) throw new Error('LLM_PROVIDER must be openai, google, anthropic, local or rules');
  if (!['dsh', 'rules'].includes(settings.agentRuntime)) throw new Error('AGENT_RUNTIME must be dsh or rules');
  if (!['inline', 'worker'].includes(settings.supportExecution)) throw new Error('SUPPORT_EXECUTION must be inline or worker');
  if (!['local', 'openai', 'google'].includes(settings.knowledgeEmbeddingsProvider)) throw new Error('KB_EMBEDDINGS_PROVIDER must be local, openai or google');
  if (!['agent', 'openrouter'].includes(settings.classificationProvider)) throw new Error('CLASSIFICATION_PROVIDER must be agent or openrouter');
  if (settings.classificationProvider === 'openrouter' && !settings.classificationModel) throw new Error('OpenRouter classification requires an explicit CLASSIFICATION_MODEL');
  if (settings.agentRuntime === 'dsh' && settings.llmProvider === 'rules') throw new Error('DSH requires a model provider');
  if (!settings.runtimeHome.trim()) throw new Error('RUNTIME_HOME must not be empty');
  if (settings.llmBaseUrl) {
    let endpoint: URL;
    try { endpoint = new URL(settings.llmBaseUrl); } catch { throw new Error('LLM_BASE_URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('LLM_BASE_URL must be an HTTP(S) URL without embedded credentials');
  }
  if (settings.llmProvider === 'local' && (!settings.llmModel || !settings.llmBaseUrl)) throw new Error('Local models require LLM_MODEL and LLM_BASE_URL');
  if (settings.bullmqDb < 2) throw new Error('BULLMQ_DB must isolate the queue from legacy Redis DB0/DB1');
  for (const [name, configured] of [['BULLMQ_PREFIX', settings.bullmqPrefix], ['BULLMQ_QUEUE', settings.bullmqQueue]]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(configured!)) throw new Error(`${name} must contain 1..64 letters, digits, hyphens or underscores`);
  }
  if (settings.environment === 'production') {
    const servicePasswords = settings.databaseUrl ? [settings.redisPassword] : [settings.postgresPassword, settings.redisPassword];
    if (servicePasswords.some(secret => secret.length < 16 || secret === 'development-only')) {
      throw new Error('Production service passwords must contain at least 16 characters');
    }
    if (settings.apiToken.length < 32 || /\s/.test(settings.apiToken) || isExampleToken(settings.apiToken)) throw new Error('Production API_TOKEN must contain at least 32 non-whitespace characters and cannot use a public example or placeholder');
    if (settings.allowedHosts.length === 0 || settings.allowedHosts.includes('*')) {
      throw new Error('Production ALLOWED_HOSTS must contain explicit hostnames');
    }
    // Safe defaults: production never silently runs in a demo shape that loses or exposes data.
    if (settings.supportStore !== 'postgres') {
      throw new Error('Production requires SUPPORT_STORE=postgres: the in-memory store loses conversations, approvals and audit on every restart');
    }
    if (settings.demoResetEnabled) {
      throw new Error('DEMO_RESET_ENABLED must be off in production: it publishes demo session tokens and lets the operator token wipe all data');
    }
    const runtimeHome = value('RUNTIME_HOME', '').trim();
    if (settings.agentRuntime === 'dsh' && (!runtimeHome || !isAbsolute(runtimeHome) || resolve(runtimeHome).startsWith(resolve(tmpdir())))) {
      throw new Error('Production DSH requires RUNTIME_HOME as an absolute path on persistent storage outside the temporary directory; otherwise agent sessions are lost on restart');
    }
  }
  if (settings.allowedHosts.some(host => host.includes('*') && (host !== '*' && (!host.startsWith('*.') || host.slice(2).includes('*'))))) {
    throw new Error('ALLOWED_HOSTS wildcard must be * or a leading *.');
  }
  return settings;
}

export function getSettings(): Settings { return settingsFrom(loadEnvironment()); }
