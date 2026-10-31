import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'support-insights-gateway';
export const inject = ['tools', 'agents'];

export function apply(ctx) {
  const endpoint = process.env.SUPPORT_GATEWAY_URL;
  const capability = process.env.SUPPORT_GATEWAY_CAPABILITY;
  if (!endpoint || !capability) throw new Error('Insights gateway capability required');
  let submitted = false;
  let steps = 0;
  ctx.tools.guard(exec => exec.name !== 'submit_insights' ? 'Tool is outside the read-only insights allowlist' : submitted ? 'Insights already submitted' : undefined);
  ctx.on('agent/pre-step', async (_payload, next) => ++steps > 3 ? { kind: 'reject' } : next());
  ctx.on('agent/created', ({ agent }) => {
    if (JSON.stringify(ctx.tools.definitions(agent).map(tool => tool.name).sort()) !== '["submit_insights"]') throw new Error('Insights tool inventory must contain only submit_insights');
  });
  // DSH's parameter DSL supports types/properties/items/enums; parent Zod applies all bounds.
  ctx.tools.register(defineTool({
    name: 'submit_insights', description: 'Submit candidate support issues based only on the provided bounded sample. This publishes nothing and executes no business action. Cite exact evidence IDs. Call once.',
    parameters: { findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, enum: ['recurring_issue', 'knowledge_gap', 'possible_contradiction'] },
      title: { type: 'string', required: true }, summary: { type: 'string', required: true }, recommendation: { type: 'string', required: true },
      evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        caseId: { type: 'string', required: true }, messageIds: { type: 'array', required: true, items: { type: 'string' } },
      } } },
      knowledgeRefs: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, version: { type: 'integer', required: true },
      } } },
      proposedArticle: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true }, content: { type: 'string', required: true },
      } }] },
    } } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const response = await fetch(endpoint, { method: 'POST', signal: exec.signal,
        headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'submit_insights', args, callId: exec.callId }) });
      if (!response.ok) throw new Error(`Insights gateway rejected the output (${response.status})`);
      submitted = true;
      const result = await response.json();
      exec.concludeTurn();
      return result;
    },
  }));
}
