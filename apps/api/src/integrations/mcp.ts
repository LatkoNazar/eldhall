import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { supportConfigSchema, type McpIntegrationConfig, type SupportConfig } from './config.js';
import { validateToolInput, type InputSchema } from './schema.js';

export interface BusinessTool {
  integrationId: string;
  name: string;
  description: string;
  inputSchema: InputSchema;
}
export interface BusinessIntegrationContext { businessId: string; customerId: string; assertActive: () => Promise<void> }
export interface ScopedBusinessTools {
  tools: BusinessTool[];
  callTool(integrationId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface BusinessIntegrations { forContext(context: BusinessIntegrationContext): ScopedBusinessTools }
export class IntegrationError extends Error {
  constructor(readonly code: 'denied' | 'invalid_input' | 'unavailable' | 'timeout' | 'invalid_output', message: string) { super(message); this.name = 'IntegrationError'; }
}

const RAW_RESPONSE_LIMIT = 131_072;
type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** Return flat, explicitly reviewed fields only. Nested objects cannot smuggle extra fields. */
function projectOutput(value: unknown, fields: string[], maxBytes: number): unknown {
  const project = (row: unknown): Record<string, Scalar | Scalar[]> => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new IntegrationError('invalid_output', 'MCP output must be a JSON object or an array of objects');
    const clean: Record<string, Scalar | Scalar[]> = {};
    for (const field of fields) {
      if (!Object.hasOwn(row, field)) continue;
      const item = (row as Record<string, unknown>)[field];
      if (isScalar(item)) clean[field] = item;
      else if (Array.isArray(item) && item.length <= 50 && item.every(isScalar)) clean[field] = item;
    }
    return clean;
  };
  if (Array.isArray(value) && value.length > 50) throw new IntegrationError('invalid_output', 'MCP output contains too many records');
  const output = Array.isArray(value) ? value.map(project) : project(value);
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new IntegrationError('invalid_output', 'MCP output exceeds configured limit');
  return output;
}

/** The SDK's auth/discovery/redirect paths may never introduce a second network target. */
function boundedFetch(endpoint: string, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(target).href !== endpoint) throw new IntegrationError('denied', 'MCP request target is not allowlisted');
    const signals = [signal, ...(init?.signal ? [init.signal] : [])];
    const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    const length = response.headers.get('content-length');
    if (length && Number(length) > RAW_RESPONSE_LIMIT) {
      await response.body?.cancel();
      throw new IntegrationError('invalid_output', 'MCP response exceeds transport limit');
    }
    if (!response.body) return response;
    let bytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > RAW_RESPONSE_LIMIT) controller.error(new IntegrationError('invalid_output', 'MCP response exceeds transport limit'));
      else controller.enqueue(chunk);
    } }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function invoke(integration: McpIntegrationConfig, tool: McpIntegrationConfig['tools'][number], context: BusinessIntegrationContext, input: Record<string, unknown>, credential: string | undefined, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), integration.timeoutMs);
  const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const client = new Client({ name: 'support-scoped-read-gateway', version: '1.0.0' });
  try {
    activeSignal.throwIfAborted();
    await context.assertActive();
    const endpoint = new URL(integration.url).href;
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: boundedFetch(endpoint, activeSignal),
      requestInit: credential ? { headers: { Authorization: `Bearer ${credential}` } } : undefined,
      onInsufficientScope: 'throw',
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const options = { signal: activeSignal, timeout: integration.timeoutMs };
    await client.connect(transport, options);
    const listing = await client.listTools(undefined, options);
    const remote = listing.tools.find(row => row.name === tool.name);
    if (!remote || remote.annotations?.readOnlyHint === false || remote.annotations?.destructiveHint === true) throw new IntegrationError('denied', 'Configured read tool is absent or advertises writes');
    await context.assertActive();
    // Bound business/customer identity comes only from the authenticated backend lease.
    const args = { ...input, [tool.scopeBindings.businessId]: context.businessId, [tool.scopeBindings.customerId]: context.customerId };
    const result = await client.callTool({ name: tool.name, arguments: args }, options);
    if (result.isError) throw new IntegrationError('unavailable', 'Business tool returned an error');
    let data: unknown = result.structuredContent;
    if (data === undefined) {
      const texts = result.content.filter(block => block.type === 'text');
      if (texts.length !== 1) throw new IntegrationError('invalid_output', 'MCP output requires structuredContent or one JSON text block');
      try { data = JSON.parse(texts[0]!.text) as unknown; } catch { throw new IntegrationError('invalid_output', 'MCP text output must contain JSON'); }
    }
    const projected = projectOutput(data, tool.outputFields, integration.maxOutputBytes);
    activeSignal.throwIfAborted();
    await context.assertActive();
    return projected;
  } catch (error) {
    if (activeSignal.aborted) throw new IntegrationError('timeout', 'Business tool deadline or run cancellation reached');
    if (error instanceof IntegrationError) throw error;
    // SDK/server errors can include URLs, headers, or body data. Never expose them to the model/API.
    throw new IntegrationError('unavailable', 'Business tool unavailable');
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

export function createBusinessIntegrations(config: SupportConfig, env: NodeJS.ProcessEnv = process.env): BusinessIntegrations {
  const reviewed = supportConfigSchema.parse(config);
  const credentials = new Map<string, string>();
  for (const integration of reviewed.integrations) if (integration.credentialEnv) {
    const credential = env[integration.credentialEnv];
    if (!credential || /[\r\n]/.test(credential)) throw new Error(`Missing or invalid MCP credential environment reference: ${integration.credentialEnv}`);
    credentials.set(integration.id, credential);
  }
  return { forContext(context) {
    if (!context.businessId || !context.customerId) throw new IntegrationError('denied', 'Trusted business and customer identity required');
    const integrations = reviewed.integrations.filter(row => row.businessId === context.businessId);
    return {
      tools: integrations.flatMap(integration => integration.tools.map(tool => ({ integrationId: integration.id, name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) }))),
      async callTool(integrationId, name, input, signal) {
        const integration = integrations.find(row => row.id === integrationId);
        const tool = integration?.tools.find(row => row.name === name);
        if (!integration || !tool) throw new IntegrationError('denied', 'Business tool is not allowlisted');
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.values(tool.scopeBindings).some(field => Object.hasOwn(input, field))) throw new IntegrationError('invalid_input', 'Model input cannot supply identity scope');
        try {
          if (Buffer.byteLength(JSON.stringify(input)) > 16_384) throw new Error('Input too large');
          validateToolInput(tool.inputSchema, input);
        } catch { throw new IntegrationError('invalid_input', 'Business tool input does not match configured schema'); }
        return invoke(integration, tool, context, structuredClone(input), credentials.get(integration.id), signal);
      },
    };
  } };
}
