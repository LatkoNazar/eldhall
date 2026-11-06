import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresSupportStore } from '../src/modules/support/postgres-store.js';
import { VersionConflict } from '../src/modules/support/store.js';
import { DEFAULT_DATABASE_LIMITS } from '../src/modules/database/contracts.js';

test('PostgreSQL database guard policy persists with settings CAS and survives other settings writers', { skip: !process.env.TEST_DATABASE_URL && !process.env.TEST_POSTGRES_HOST }, async () => {
  const schema = 'test_database_policy_' + randomUUID().replaceAll('-', '');
  const explicit = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : undefined;
  const host = explicit?.hostname ?? process.env.TEST_POSTGRES_HOST;
  const port = Number(explicit?.port ?? process.env.TEST_POSTGRES_PORT);
  if (host !== '127.0.0.1' || port !== 25434 && !(port === 5432 && process.env.GITHUB_ACTIONS === 'true')) throw new Error('Explicit disposable PostgreSQL fixture required');
  const connection = explicit ? { connectionString: explicit.href } : {
    host, port, database: process.env.TEST_POSTGRES_DB, user: process.env.TEST_POSTGRES_USER, password: process.env.TEST_POSTGRES_PASSWORD, ssl: false,
  };
  const admin = new pg.Pool(connection);
  let scoped: pg.Pool | undefined;
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    scoped = new pg.Pool({ ...connection, options: '-c search_path=' + schema });
    await scoped.query('CREATE TABLE support_businesses(id uuid PRIMARY KEY,slug text,name text,currency text,policy jsonb)');
    await scoped.query('CREATE TABLE support_settings(business_id uuid PRIMARY KEY,version int,language text,tone text,require_approval bool,refund_limit_cents int,duplicate_window_minutes int,enabled_tools jsonb,classification jsonb)');
    const businessId = randomUUID();
    const originalPolicy = { refundLimitCents: 50000, duplicateWindowMinutes: 60, enabledTools: ['lookup_payments'], guards: [], guardRevision: 3 };
    await scoped.query('INSERT INTO support_businesses VALUES($1,$2,$3,$4,$5)', [businessId, 'test-bank', 'Synthetic bank', 'UAH', JSON.stringify(originalPolicy)]);
    const store = new PostgresSupportStore(scoped);
    const initial = await store.settings(businessId);
    const databaseInvestigation = { enabled: true, limits: { ...DEFAULT_DATABASE_LIMITS, maxRows: 17 } };
    await store.saveSettings({ ...initial, version: 2, databaseInvestigation }, 1);
    const freshStore = new PostgresSupportStore(scoped);
    assert.deepEqual((await freshStore.settings(businessId)).databaseInvestigation, databaseInvestigation);
    await assert.rejects(freshStore.saveSettings({ ...initial, version: 2 }, 1), VersionConflict);
    const { databaseInvestigation: omitted, ...ordinary } = await freshStore.settings(businessId);
    assert.equal(omitted?.enabled, true);
    await freshStore.saveSettings({ ...ordinary, version: 3, language: 'en' }, 2);
    const saved = await freshStore.settings(businessId);
    assert.deepEqual(saved.databaseInvestigation, databaseInvestigation);
    assert.equal(saved.guardRevision, 3);
    assert.deepEqual((await freshStore.business(businessId))!.policy.databaseInvestigation, databaseInvestigation);
    assert.equal(saved.version, 3);
  } finally {
    await scoped?.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
  }
});
