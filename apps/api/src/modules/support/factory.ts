import type pg from 'pg';
import type { Settings } from '../../core/config.js';
import { AiSdkModel } from '../agent/ai-model.js';
import { SupportHarness } from '../agent/harness.js';
import { RulesModel } from '../agent/model.js';
import { SimulatedPaymentProvider } from './payment-provider.js';
import type { SupportDependencies } from './routes.js';
import { seedData } from './seed.js';
import { MemorySupportStore, type SupportStore } from './store.js';

export async function createSupport(settings: Settings, pool: pg.Pool): Promise<SupportDependencies> {
  if (settings.environment === 'production' && settings.operatorToken.length < 24) {
    throw new Error('Production OPERATOR_TOKEN must contain at least 24 characters');
  }
  let store: SupportStore;
  if (settings.supportStore === 'postgres') {
    // WS3: return new PostgresSupportStore(pool) once migrations/0002_support.sql lands.
    throw new Error(`SUPPORT_STORE=postgres is not implemented yet (pool ${pool.totalCount})`);
  } else {
    store = new MemorySupportStore();
    await store.reset(seedData());
  }
  const fallback = new RulesModel();
  const model = settings.llmProvider === 'rules' ? fallback : new AiSdkModel(settings.llmProvider, settings.llmModel, settings.llmApiKey);
  const harness = new SupportHarness({ store, model, fallback, provider: new SimulatedPaymentProvider(), timeoutMs: settings.llmTimeoutMs });
  return { harness, store };
}
