import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { supportConfigSchema, type McpIntegrationConfig, type SupportConfig } from './config.js';
import { validateToolInput, type InputSchema } from './schema.js';

export interface BusinessTool {
  integrationId: string;
  name: string;
  description: string;
  inputSchema: InputSchema;
}
/** Model-facing operation result (docs/integrations-manifest.md). Pending is never success. */
export type BusinessToolResult =
  | { status: 'executed'; actionId?: string; data: unknown }
  | { status: 'awaiting_approval'; proposalId: string; summary: string }
  | { status: 'denied'; reasonCode: string }
  | { status: 'failed'; actionId?: string; reasonCode: string }
  | { status: 'unknown'; actionId: string; reasonCode: string };
/** Outcome of dispatching one recorded action. `unknown` = the upstream effect may have happened. */
export type ActionGuardEvaluation = { id: string | null; status: 'not_required' | 'passed' | 'rejected' | 'unknown' };
export type ActionOutcome = ({ status: 'executed'; data: unknown } | { status: 'failed' | 'unknown'; reasonCode: string }) & { guard?: ActionGuardEvaluation };
/** Immutable snapshot stored as proposal args; its hash binds approval to the exact operation and versions. */
export interface ExternalActionRequest { args: Record<string, unknown>; mode: 'auto' | 'ask'; title: string }
export interface BusinessIntegrationContext {
  businessId: string; customerId: string; assertActive: () => Promise<void>;
  caseId?: string; ownershipVersion?: number;
  markDispatched?: () => Promise<void>;
  rememberPolicy?: (integrationId: string, manifestHash: string, connectionRevision: string, policyRevision: number) => void;
  /** Supplied by the harness during a turn: records the action durably (and runs it for `auto`). */
  propose?: (request: ExternalActionRequest) => Promise<BusinessToolResult>;
}
export interface ScopedBusinessTools {
  tools: BusinessTool[];
  listTools?(): Promise<BusinessTool[]>;
  callTool(integrationId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Re-checks the snapshot against current policy/manifest, then dispatches with `actionId` as idempotency key. */
  executeAction?(args: Record<string, unknown>, actionId: string, signal?: AbortSignal): Promise<ActionOutcome>;
}
export interface BusinessIntegrations {
  forContext(context: BusinessIntegrationContext): ScopedBusinessTools;
  verifyCatalog?(businessId: string, integrationId: string, manifestHash: string, connectionRevision: string): Promise<void>;
}
export class IntegrationError extends Error {
  constructor(readonly code: 'denied' | 'invalid_input' | 'unavailable' | 'timeout' | 'invalid_output', message: string) { super(message); this.name = 'IntegrationError'; }
}

const RAW_RESPONSE_LIMIT = 131_072;
type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** Return flat, explicitly reviewed fields only. Nested objects cannot smuggle extra fields. */
export function projectOutput(value: unknown, fields: string[], maxBytes: number): unknown {
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

export interface McpTarget { url: string; timeoutMs: number; credential?: string }
export type McpCallOptions = { signal: AbortSignal; timeout: number };

/** One bounded, single-endpoint MCP session. SDK/server errors are masked; only IntegrationError codes escape. */
export async function withMcpClient<T>(target: McpTarget, context: BusinessIntegrationContext, signal: AbortSignal | undefined, run: (client: Client, options: McpCallOptions) => Promise<T>, preserveReceivedResult = false): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const client = new Client({ name: 'support-scoped-read-gateway', version: '1.0.0' });
  try {
    activeSignal.throwIfAborted();
    await context.assertActive();
    const endpoint = new URL(target.url).href;
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: boundedFetch(endpoint, activeSignal),
      requestInit: target.credential ? { headers: { Authorization: `Bearer ${target.credential}` } } : undefined,
      onInsufficientScope: 'throw',
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const options = { signal: activeSignal, timeout: target.timeoutMs };
    await client.connect(transport, options);
    const result = await run(client, options);
    if(!preserveReceivedResult) { activeSignal.throwIfAborted(); await context.assertActive(); }
    return result;
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

/** structuredContent, or exactly one JSON text block. */
export function toolData(result: { structuredContent?: unknown; content: { type: string; text?: string }[] }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = result.content.filter(block => block.type === 'text');
  if (texts.length !== 1) throw new IntegrationError('invalid_output', 'MCP output requires structuredContent or one JSON text block');
  try { return JSON.parse(texts[0]!.text ?? '') as unknown; } catch { throw new IntegrationError('invalid_output', 'MCP text output must contain JSON'); }
}

async function invoke(integration: McpIntegrationConfig, tool: McpIntegrationConfig['tools'][number], context: BusinessIntegrationContext, input: Record<string, unknown>, credential: string | undefined, signal?: AbortSignal): Promise<unknown> {
  return withMcpClient({ url: integration.url, timeoutMs: integration.timeoutMs, credential }, context, signal, async (client, options) => {
    const listing = await client.listTools(undefined, options);
    const remote = listing.tools.find(row => row.name === tool.name);
    if (!remote || remote.annotations?.readOnlyHint === false || remote.annotations?.destructiveHint === true) throw new IntegrationError('denied', 'Configured read tool is absent or advertises writes');
    await context.assertActive();
    // Bound business/customer identity comes only from the authenticated backend lease.
    const args = { ...input, [tool.scopeBindings.businessId]: context.businessId, [tool.scopeBindings.customerId]: context.customerId };
    const result = await client.callTool({ name: tool.name, arguments: args }, options);
    if (result.isError) throw new IntegrationError('unavailable', 'Business tool returned an error');
    return projectOutput(toolData(result), tool.outputFields, integration.maxOutputBytes);
  });
}

/** One registry per business: routes each call to the integration that owns `integrationId`, never by tool name alone. */
export function combineIntegrations(parts: { owns: readonly (readonly [businessId: string, integrationId: string])[]; integrations: BusinessIntegrations }[]): BusinessIntegrations {
  return { async verifyCatalog(businessId, integrationId, manifestHash, connectionRevision) {
    const owner = parts.find(part => part.owns.some(([business, id]) => business === businessId && id === integrationId));
    if (!owner?.integrations.verifyCatalog) throw new IntegrationError('denied', 'Catalog is not loaded');
    await owner.integrations.verifyCatalog(businessId, integrationId, manifestHash, connectionRevision);
  }, forContext(context) {
    const scoped = parts
      .map(part => ({ ids: part.owns.filter(([businessId]) => businessId === context.businessId).map(([, integrationId]) => integrationId), part }))
      .filter(entry => entry.ids.length)
      .map(entry => ({ ids: entry.ids, tools: entry.part.integrations.forContext(context) }));
    const route = (integrationId: unknown) => typeof integrationId === 'string' ? scoped.find(entry => entry.ids.includes(integrationId))?.tools : undefined;
    return {
      tools: scoped.flatMap(entry => entry.tools.tools),
      async listTools() { return (await Promise.all(scoped.map(entry => entry.tools.listTools ? entry.tools.listTools() : entry.tools.tools))).flat(); },
      async callTool(integrationId, name, input, signal) {
        const owner = route(integrationId);
        if (!owner) throw new IntegrationError('denied', 'Business tool is not allowlisted');
        return owner.callTool(integrationId, name, input, signal);
      },
      async executeAction(args, actionId, signal) {
        const owner = route(args.integrationId);
        return owner?.executeAction ? owner.executeAction(args, actionId, signal) : { status: 'failed', reasonCode: 'integration_unavailable' };
      },
    };
  } };
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
