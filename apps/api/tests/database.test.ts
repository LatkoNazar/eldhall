import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { settingsFrom } from '../src/core/config.js';
import { createPool } from '../src/core/database.js';

test('DATABASE_URL routes the real pg client without split credentials and retains encoded values and TLS options', async () => {
  const url = 'postgresql://url-user:p%40ss%3Aword%2F%23%25@db.example.test:6543/existing%20app?sslmode=verify-full&application_name=support';
  const settings = settingsFrom({
    DATABASE_URL: `  ${url}  `,
    POSTGRES_HOST: 'ignored.example.test', POSTGRES_PORT: 'invalid',
    POSTGRES_DB: 'ignored', POSTGRES_USER: 'ignored', POSTGRES_PASSWORD: 'ignored',
  });
  const pool = createPool(settings);
  try {
    assert.equal(pool.options.connectionString, url);
    for (const name of ['host', 'port', 'database', 'user', 'password']) assert.equal(Object.hasOwn(pool.options, name), false);
    // Constructing the driver's client resolves connectionString without opening a socket.
    const client = new pg.Client(pool.options);
    assert.equal(client.host, 'db.example.test');
    assert.equal(client.port, 6543);
    assert.equal(client.database, 'existing app');
    assert.equal(client.user, 'url-user');
    assert.equal(client.password, 'p@ss:word/#%');
    const ssl: unknown = client.ssl;
    assert.ok(ssl !== null && typeof ssl === 'object');
    assert.notEqual('rejectUnauthorized' in ssl ? ssl.rejectUnauthorized : undefined, false);
    assert.equal(pool.options.max, 10);
    assert.equal(pool.options.connectionTimeoutMillis, 3000);
    assert.equal(pool.options.statement_timeout, 5000);
    assert.equal(pool.options.query_timeout, 6000);
    assert.equal(pool.options.idleTimeoutMillis, 10000);
  } finally { await pool.end(); }
});

test('missing or blank DATABASE_URL keeps the existing split-parameter connection', async () => {
  for (const url of [undefined, '', '   ']) {
    const settings = settingsFrom({
      DATABASE_URL: url, POSTGRES_HOST: 'split.example.test', POSTGRES_PORT: '5433',
      POSTGRES_DB: 'support_dev', POSTGRES_USER: 'split-user', POSTGRES_PASSWORD: 'split-password',
    });
    const pool = createPool(settings);
    try {
      assert.equal(Object.hasOwn(pool.options, 'connectionString'), false);
      const client = new pg.Client(pool.options);
      assert.equal(client.host, 'split.example.test');
      assert.equal(client.port, 5433);
      assert.equal(client.database, 'support_dev');
      assert.equal(client.user, 'split-user');
      assert.equal(client.password, 'split-password');
    } finally { await pool.end(); }
  }
});

test('URL production configuration uses the existing database credentials while preserving other production guards', () => {
  const production = {
    ENVIRONMENT: 'production', DATABASE_URL: 'postgres://existing:short@db.example.test/existing',
    REDIS_PASSWORD: 'r'.repeat(32), API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '["support.example.test"]',
  };
  assert.equal(settingsFrom(production).databaseUrl, production.DATABASE_URL);
  assert.equal(settingsFrom({ ...production, POSTGRES_PASSWORD: '', POSTGRES_PORT: 'not-used' }).databaseUrl, production.DATABASE_URL);
  assert.throws(() => settingsFrom({ ...production, REDIS_PASSWORD: 'short' }), /passwords/);
  assert.throws(() => settingsFrom({ ...production, API_TOKEN: 'short' }), /API_TOKEN/);
  assert.throws(() => settingsFrom({ ...production, ALLOWED_HOSTS: '["*"]' }), /ALLOWED_HOSTS/);
  assert.throws(() => settingsFrom({ ...production, DATABASE_URL: '' }), /passwords/);
  assert.throws(() => settingsFrom({ DATABASE_URL: '', POSTGRES_PORT: 'invalid' }), /POSTGRES_PORT/);
});

test('malformed DATABASE_URL fails with a fixed message that never exposes credentials', () => {
  const secret = 'sensitive-url-credential';
  const invalid = [
    `https://user:${secret}@db.example.test/existing`,
    `postgres://user:${secret}@/existing`,
    `postgres://user:${secret}@db.example.test`,
    `postgres://user:${secret}@db.example.test/`,
    `postgres://user:${secret}@db.example.test:0/existing`,
    `postgres://user:${secret}@db.example.test:65536/existing`,
    `postgres://user:${secret}@db.example.test:invalid/existing`,
    `postgres://user:${secret}%ZZ@db.example.test/existing`,
    `postgres://user:${secret}@invalid%ZZ.example.test/existing`,
    `postgres://user:${secret}@db.example.test/existing#fragment`,
    `postgres://user:${secret}@db.example.test/existing\n?sslmode=disable`,
    `invalid-${secret}`,
  ];
  for (const url of invalid) {
    assert.throws(() => settingsFrom({ DATABASE_URL: url }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'DATABASE_URL must be a valid postgres:// or postgresql:// URL with a host and database');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack ?? '', new RegExp(secret));
      return true;
    });
  }
});
