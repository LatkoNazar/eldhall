import { getSettings } from './core/config.js';
import { createPool } from './core/database.js';
import { migrate } from './core/migrations.js';
import { migrateSupport } from './modules/support/migrations.js';

async function main() {
  const pool = createPool(getSettings());
  try { await migrate(pool); await migrateSupport(pool); console.log('Schema is compatible at 0001_jobs + support v1'); }
  finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
