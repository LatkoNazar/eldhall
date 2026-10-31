// LLM spike: real tool calling per provider whose key is set in .env.
// Run: cd apps/api && npx tsx scripts/llm-spike.ts
import { loadEnvironment } from '../src/core/config.js';
import { AiSdkModel, DEFAULT_MODELS, type Provider } from '../src/modules/agent/ai-model.js';
import type { AgentContext } from '../src/modules/agent/model.js';
import { evaluatePolicy } from '../src/modules/agent/policy.js';
import { seedData } from '../src/modules/support/seed.js';

const env = loadEnvironment();
Object.assign(process.env, env);
const keys: Record<Provider, string> = { openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const seed = seedData();
const business = seed.businesses[0]!;
const customer = seed.customers[0]!;
const payments = seed.payments.filter(p => p.customerId === customer.id);
const message = 'Ви списали з мене двічі за жовтень!!! Негайно поверніть гроші';
const ctx: AgentContext = {
  customer: { name: customer.name, plan: customer.plan }, business, payments,
  history: [{ role: 'customer', body: message }], message,
  // Restriction check: escalate_to_human is deliberately NOT offered here.
  allowedTools: ['lookup_payments', 'refund_payment'],
};

for (const provider of Object.keys(keys) as Provider[]) {
  if (!env[keys[provider]]) { console.log(`- ${provider}: skipped (${keys[provider]} not set)`); continue; }
  const model = new AiSdkModel(provider, provider === env.LLM_PROVIDER ? env.LLM_MODEL : undefined);
  const started = Date.now();
  try {
    const out = await model.decide(ctx, AbortSignal.timeout(30000));
    const policy = out.decision.action ? evaluatePolicy(out.decision.action.tool, out.decision.action.args, { business, customer, payments, refunds: [], openProposals: [] }) : null;
    console.log(`+ ${provider} (${model.model}) ${Date.now() - started} ms, steps=${out.steps}, tools=${out.toolCalls.join(' > ')}`);
    console.log(`  intent=${out.decision.intent} sentiment=${out.decision.sentiment.label}/${out.decision.sentiment.urgency} action=${JSON.stringify(out.decision.action)}`);
    console.log(`  policy allowed=${policy?.allowed} failed=${policy?.checks.filter(c => !c.passed).map(c => c.name).join(',') || '-'}`);
    console.log(`  reply: ${out.decision.reply.slice(0, 200)}`);
  } catch (error) {
    console.log(`x ${provider} (${model.model || DEFAULT_MODELS[provider]}) failed: ${error instanceof Error ? error.message.slice(0, 300) : error}`);
  }
}
