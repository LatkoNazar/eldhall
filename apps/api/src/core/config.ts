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
  rabbitmqHost: string;
  rabbitmqPort: number;
  rabbitmqUser: string;
  rabbitmqPassword: string;
  rabbitmqVhost: string;
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
    rabbitmqHost: value('RABBITMQ_HOST', 'rabbitmq'),
    rabbitmqPort: integer('RABBITMQ_PORT', '5672'),
    rabbitmqUser: value('RABBITMQ_USER', 'app'),
    rabbitmqPassword: value('RABBITMQ_PASSWORD', 'development-only'),
    rabbitmqVhost: value('RABBITMQ_VHOST', 'app'),
    apiToken: value('API_TOKEN', ''),
    allowedHosts: array('ALLOWED_HOSTS', '["localhost","127.0.0.1","testserver"]'),
    corsOrigins: array('CORS_ORIGINS', '[]'),
    workerConcurrency: integer('WORKER_CONCURRENCY', value('CELERY_CONCURRENCY', '2'), 64),
  };
  if (settings.environment === 'production') {
    if ([settings.postgresPassword, settings.redisPassword, settings.rabbitmqPassword].some(secret => secret.length < 16 || secret === 'development-only')) {
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
