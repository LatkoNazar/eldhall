import pg from 'pg';
import type { SupportConfig } from './config.js';
import { IntegrationError, type BusinessIntegrations } from './mcp.js';
import type { SupportStore } from '../modules/support/store.js';
import { databaseInvestigationPolicy } from '../modules/support/database-guards.js';
import { createDatabaseInvestigationService } from '../modules/database/service.js';

/** Deployment-owned credentials are used only by dedicated read-only pools, never the model process. */
export async function createDatabaseIntegrations(config: SupportConfig, env: NodeJS.ProcessEnv, store: SupportStore, base: BusinessIntegrations) {
  const sources: { config: SupportConfig['databaseSources'][number]; pool: pg.Pool }[] = [];
  try {
    for (const source of config.databaseSources) {
      if (await store.integrationStore.get(source.businessId, source.id)) throw new Error('Database source identity conflicts with an API integration');
      const connectionString = env[source.credentialEnv];
      let url: URL;
      try { url = new URL(connectionString ?? ''); } catch { throw new Error('Database source credential reference is unavailable'); }
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || connectionString!.length > 16_384) throw new Error('Database source requires a PostgreSQL connection URL');
      const pool = new pg.Pool({
        connectionString, max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000,
        application_name: 'eldhall-customer-investigation',
      });
      // pg emits idle connection errors separately; never log credentials or server error details.
      pool.on('error', () => console.warn('Customer database connection unavailable'));
      sources.push({ config: source, pool });
    }
    const databaseInvestigations = createDatabaseInvestigationService({
      sources,
      getPolicy: async businessId => {
        const settings = await store.settings(businessId);
        return { version: settings.version, ...databaseInvestigationPolicy(settings.databaseInvestigation) };
      },
    });
    const owned = (businessId: string, integrationId: string) => config.databaseSources.some(source => source.businessId === businessId && source.id === integrationId);
    const integrations: BusinessIntegrations = {
      verifyCatalog: base.verifyCatalog?.bind(base),
      forContext(context) {
        const original = base.forContext(context), database = databaseInvestigations.forContext(context);
        const filtered = <T extends { integrationId: string }>(tools: T[]) => tools.filter(tool => !owned(context.businessId, tool.integrationId));
        return {
          tools: [...filtered(original.tools), ...database.tools],
          async listTools() {
            const ordinary = original.listTools ? await original.listTools() : original.tools;
            const reads = database.listTools ? await database.listTools() : database.tools;
            return [...filtered(ordinary), ...reads];
          },
          callTool(id, name, input, signal) {
            return (owned(context.businessId, id) ? database : original).callTool(id, name, input, signal);
          },
          async canBatchRead(id, name) {
            // SQL reads retain their individual guard path; there is no per-operation Auto proof.
            return owned(context.businessId, id) ? false : await original.canBatchRead?.(id, name) ?? false;
          },
          async executeAction(args, actionId, signal) {
            if (owned(context.businessId, String(args.integrationId))) throw new IntegrationError('denied', 'Database investigation cannot execute business actions');
            return original.executeAction?.(args, actionId, signal) ?? { status: 'failed', reasonCode: 'integration_unavailable' };
          },
        };
      },
    };
    return { integrations, databaseInvestigations };
  } catch (error) {
    await Promise.allSettled(sources.map(source => source.pool.end()));
    throw error;
  }
}
