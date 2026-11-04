import { createApp } from './app.js';
import { getSettings } from './core/config.js';
import { createPool } from './core/database.js';
import { dispatchJob, queueJobFailed } from './core/queue.js';
import { PostgresJobStore } from './modules/jobs/repository.js';
import { readJob } from './modules/jobs/service.js';
import { dependencyChecks } from './modules/system/health.js';
import { createSupport } from './modules/support/factory.js';
import { createInsights } from './modules/insights/factory.js';

async function main() {
  let settings: ReturnType<typeof getSettings>;
  // Configuration messages are written to name the setting, never its value, so the reason is safe to log.
  try { settings = getSettings(); } catch (error) {
    console.error(`API configuration invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
    return;
  }
  const pool = createPool(settings);
  const store = new PostgresJobStore(pool);
  const app = await createApp(settings, { store, dispatch: id => dispatchJob(settings, id), checks: dependencyChecks(settings, pool), readJob: id => readJob(store, id, jobId => queueJobFailed(settings, jobId)), support: await createSupport(settings, pool), insights: await createInsights(settings, pool) }, true);
  app.addHook('onClose', async () => pool.end());
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await app.listen({ host: '0.0.0.0', port: 8000 });
}
main().catch(() => { console.error('API startup failed; verify configuration and dependencies'); process.exitCode = 1; });
