import type pg from 'pg';
import { loadEnvironment, type Settings } from '../../core/config.js';
import { loadSupportConfig } from '../../integrations/config.js';
import { bootstrapSupportConfig } from '../../integrations/bootstrap.js';
import { createSupportIntegrations } from '../../integrations/catalog.js';
import { DshSupportModel } from '../../runtime/dsh-model.js';
import { SupportHarness } from '../agent/harness.js';
import { RulesModel } from '../agent/model.js';
import { OpenRouterTicketClassifier } from '../agent/openrouter-classifier.js';
import { SimulatedPaymentProvider } from './payment-provider.js';
import type { SupportDependencies } from './routes.js';
import { seedData } from './seed.js';
import { MemorySupportStore, type SupportStore } from './store.js';
import { PostgresSupportStore } from './postgres-store.js';
import { isExampleToken } from '../../core/auth.js';
import { createEmbedder } from '../knowledge/embeddings.js';
import { KnowledgeRetriever } from '../knowledge/retriever.js';
import { configureKnowledge } from '../knowledge/runtime.js';
import { PgVectorStore } from '../knowledge/vector-store.js';
import { createExternalKnowledge } from '../knowledge/qdrant.js';

export async function createSupport(settings: Settings, pool: pg.Pool): Promise<SupportDependencies> {
  if (settings.supportExecution === 'worker' && settings.supportStore !== 'postgres') throw new Error('Worker support execution requires SUPPORT_STORE=postgres; use SUPPORT_EXECUTION=inline for an explicit memory demo');
  if (settings.environment === 'production' && (settings.operatorToken.length < 24 || /\s/.test(settings.operatorToken) || isExampleToken(settings.operatorToken))) {
    throw new Error('Production OPERATOR_TOKEN must contain at least 24 non-whitespace characters and cannot use a public example or placeholder');
  }
  let store: SupportStore;
  if (settings.supportStore === 'postgres') {
    // Fail startup before accepting traffic when the release migration was omitted.
    await pool.query('SELECT turn_job_id FROM support_agent_runs LIMIT 0');
    await pool.query('SELECT id FROM support_turn_jobs LIMIT 0');
    await pool.query('SELECT classification FROM support_settings LIMIT 0');
    await pool.query('SELECT external_source_refs FROM support_messages LIMIT 0');
    store = new PostgresSupportStore(pool);
    if (settings.demoResetEnabled) await store.seedIfEmpty(seedData());
  } else {
    store = new MemorySupportStore();
    if (settings.demoResetEnabled) await store.reset(seedData());
  }
  await store.recoverInterruptedExecutions();
  const config = await loadSupportConfig(settings.supportConfigFile || undefined);
  const integrations = createSupportIntegrations(config, loadEnvironment());
  await bootstrapSupportConfig(store, config);
  const fallback = new RulesModel();
  const model = settings.agentRuntime === 'rules' ? fallback : new DshSupportModel({
    provider: settings.llmProvider as 'google' | 'openai' | 'anthropic' | 'local', model: settings.llmModel,
    apiKey: settings.llmApiKey, baseURL: settings.llmBaseUrl || undefined, homeRoot: settings.runtimeHome,
    timeoutMs: settings.llmTimeoutMs, maxToolCalls: settings.maxRuntimeToolCalls,
  });
  const classifier = settings.classificationProvider === 'openrouter' ? new OpenRouterTicketClassifier({
    model: settings.classificationModel, apiKey: settings.classificationApiKey, timeoutMs: settings.classificationTimeoutMs,
  }) : undefined;
  // Knowledge retrieval: embedder from KB_EMBEDDINGS_*, pgvector when the Postgres store has the extension.
  const vectors = settings.supportStore === 'postgres' ? await PgVectorStore.connect(pool) : null;
  const knowledge = new KnowledgeRetriever(createEmbedder(settings.knowledgeEmbeddingsProvider, settings.knowledgeEmbeddingsModel, settings.knowledgeEmbeddingsApiKey), vectors, message => console.warn(message));
  const externalKnowledge = createExternalKnowledge(config.externalKnowledge, loadEnvironment());
  configureKnowledge({ retriever: knowledge, external: externalKnowledge, urlAllowlist: settings.knowledgeUrlAllowlist });
  const harness = new SupportHarness({ store, model, fallback, classifier, provider: new SimulatedPaymentProvider(), timeoutMs: settings.llmTimeoutMs, integrations, knowledge, externalKnowledge });
  return { harness, store, execution: settings.supportExecution, capabilities: { execution: settings.supportExecution, runtime: settings.agentRuntime, provider: model.provider, model: model.model,
    persistence: settings.supportStore, paymentProvider: 'simulated', credentialsConfigured: settings.agentRuntime === 'rules' || settings.llmProvider === 'local' || Boolean(settings.llmApiKey),
    knowledgeSearch: 'hybrid', approvals: 'separate-execution', maxToolCalls: settings.maxRuntimeToolCalls,
    classification: { provider: classifier?.provider ?? 'agent', model: classifier?.model ?? model.model,
      credentialsConfigured: classifier ? Boolean(settings.classificationApiKey) : settings.agentRuntime === 'rules' || settings.llmProvider === 'local' || Boolean(settings.llmApiKey) } } };
}
