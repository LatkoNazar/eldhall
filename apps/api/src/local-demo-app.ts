import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { settingsFrom } from './core/config.js';
import { SupportHarness } from './modules/agent/harness.js';
import { RulesModel } from './modules/agent/model.js';
import type { JobStore } from './modules/jobs/repository.js';
import type { Job, JobCreate } from './modules/jobs/schema.js';
import { executeJob, MissingJob } from './modules/jobs/service.js';
import { KnowledgeRetriever } from './modules/knowledge/retriever.js';
import { configureKnowledge, KnowledgeImportError } from './modules/knowledge/runtime.js';
import { SimulatedPaymentProvider } from './modules/support/payment-provider.js';
import { seedData } from './modules/support/seed.js';
import { MemorySupportStore } from './modules/support/store.js';

export const localDemoAddress = Object.freeze({ host: '127.0.0.1', port: 8000 });

// Real in-memory starter jobs; no queue client or external persistence is created.
class DemoJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  async create(payload: JobCreate): Promise<Job> {
    const timestamp = new Date().toISOString();
    const job: Job = { id: randomUUID(), text: payload.text, operation: payload.operation ?? 'uppercase', status: 'queued', result: null, error: null, created_at: timestamp, updated_at: timestamp };
    this.jobs.set(job.id, job); return { ...job };
  }
  async find(id: string) { const job = this.jobs.get(id); return job ? { ...job } : null; }
  private update(id: string, patch: Partial<Job>) {
    const job = this.jobs.get(id);
    if (!job) throw new MissingJob('Job does not exist');
    if (job.status !== 'succeeded') Object.assign(job, patch, { updated_at: new Date().toISOString() });
  }
  async running(id: string) { this.update(id, { status: 'running', error: null }); }
  async succeeded(id: string, result: string) { this.update(id, { status: 'succeeded', result, error: null }); }
  async failed(id: string, error: string) { this.update(id, { status: 'failed', error }); }
}

/** Explicit local fixture only. Never load .env or pass ambient settings here. */
export async function createLocalDemoApp() {
  const settings = settingsFrom({
    ENVIRONMENT: 'development', OPERATOR_TOKEN: '1111', API_TOKEN: '1111',
    ALLOWED_HOSTS: '["127.0.0.1","localhost"]', CORS_ORIGINS: '[]',
    SUPPORT_STORE: 'memory', SUPPORT_EXECUTION: 'inline', DEMO_RESET_ENABLED: 'true',
    LLM_PROVIDER: 'rules', AGENT_RUNTIME: 'rules', CLASSIFICATION_PROVIDER: 'agent',
    KB_EMBEDDINGS_PROVIDER: 'local', KB_URL_ALLOWLIST: '[]',
  });
  const store = new MemorySupportStore(); await store.reset(seedData());
  const model = new RulesModel(), knowledge = new KnowledgeRetriever();
  configureKnowledge({ retriever: knowledge, external: undefined, urlAllowlist: [], fetcher: async () => { throw new KnowledgeImportError(403, 'URL imports are disabled in the local demo'); } });
  const harness = new SupportHarness({ store, model, fallback: model, provider: new SimulatedPaymentProvider(), knowledge, timeoutMs: 1000 });
  const jobs = new DemoJobStore();
  return createApp(settings, {
    store: jobs, dispatch: async id => { await executeJob(jobs, id); },
    checks: { memory: () => store.listCases() },
    support: { store, harness, execution: 'inline', capabilities: {
      execution: 'inline', runtime: 'rules', provider: model.provider, model: model.model,
      persistence: 'memory', paymentProvider: 'simulated', credentialsConfigured: true,
      knowledgeSearch: 'hybrid', approvals: 'separate-execution', maxToolCalls: settings.maxRuntimeToolCalls,
    } },
  });
}
