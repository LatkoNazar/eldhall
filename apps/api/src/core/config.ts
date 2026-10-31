import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export interface Settings {
  environment: 'development' | 'production';
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
  if (environment !== 'development' && environment !== 'production') {
    throw new Error('ENVIRONMENT must be development or production');
  }
  const settings: Settings = {
    environment,
    postgresHost: value('POSTGRES_HOST', 'postgres'),
    postgresPort: integer('POSTGRES_PORT', '5432'),
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
  };
  if (settings.bullmqDb < 2) throw new Error('BULLMQ_DB must isolate the queue from legacy Redis DB0/DB1');
  for (const [name, configured] of [['BULLMQ_PREFIX', settings.bullmqPrefix], ['BULLMQ_QUEUE', settings.bullmqQueue]]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(configured!)) throw new Error(`${name} must contain 1..64 letters, digits, hyphens or underscores`);
  }
  if (settings.environment === 'production') {
    if ([settings.postgresPassword, settings.redisPassword].some(secret => secret.length < 16 || secret === 'development-only')) {
      throw new Error('Production service passwords must contain at least 16 characters');
    }
    if (settings.apiToken.length < 32) throw new Error('Production API_TOKEN must contain at least 32 characters');
    if (settings.allowedHosts.length === 0 || settings.allowedHosts.includes('*')) {
      throw new Error('Production ALLOWED_HOSTS must contain explicit hostnames');
    }
  }
  if (settings.allowedHosts.some(host => host.includes('*') && (host !== '*' && (!host.startsWith('*.') || host.slice(2).includes('*'))))) {
    throw new Error('ALLOWED_HOSTS wildcard must be * or a leading *.');
  }
  return settings;
}

export function getSettings(): Settings { return settingsFrom(loadEnvironment()); }
