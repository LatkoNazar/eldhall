import type pg from 'pg';
import type { Settings } from '../../core/config.js';
import { DshInsightsModel } from '../../runtime/insights-model.js';
import { InsightsRepository } from './repository.js';
import { InsightsService } from './service.js';

export async function createInsights(settings: Settings, pool: pg.Pool): Promise<InsightsService | undefined> {
  if (settings.supportStore !== 'postgres') return undefined;
  const repository = new InsightsRepository(pool);
  await repository.assertSchema();
  const configured = settings.agentRuntime === 'dsh' && (settings.llmProvider === 'local' || Boolean(settings.llmApiKey));
  const model = configured ? new DshInsightsModel({ provider: settings.llmProvider as 'google' | 'openai' | 'anthropic' | 'local',
    model: settings.llmModel, apiKey: settings.llmApiKey, baseURL: settings.llmBaseUrl || undefined,
    homeRoot: settings.runtimeHome, timeoutMs: settings.llmTimeoutMs }) : undefined;
  return new InsightsService(repository, model, settings.llmTimeoutMs,settings.supportWorkspaceBusinessId||undefined);
}
