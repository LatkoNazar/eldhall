import pg from 'pg';
import type { Settings } from './config.js';

export function createPool(settings: Settings): pg.Pool {
  const pool = new pg.Pool({
    ...(settings.databaseUrl ? { connectionString: settings.databaseUrl } : {
      host: settings.postgresHost, port: settings.postgresPort,
      database: settings.postgresDb, user: settings.postgresUser,
      password: settings.postgresPassword,
    }),
    max: 10,
    connectionTimeoutMillis: 3000, statement_timeout: 5000,
    query_timeout: 6000, idleTimeoutMillis: 10000,
  });
  pool.on('error', () => console.warn('PostgreSQL idle connection unavailable'));
  return pool;
}
