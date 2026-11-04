import { z } from 'zod';
import { manifestSchema, type Manifest } from './manifest.js';
import { INTERNAL_SERVICE_ORIGIN, type SupportConfig } from './config.js';
import { combineIntegrations, createBusinessIntegrations, IntegrationError, projectOutput, toolData, withMcpClient, type ActionOutcome, type BusinessIntegrations, type BusinessTool } from './mcp.js';
import { integrationPolicySchema, resolveWithPolicy, type PermissionDecision } from './permissions.js';
import { validateToolInput } from './schema.js';

/**
 * Manifest-backed business tools served by the Python sidecar (apps/mcp-openapi).
 * `auto` reads run inline. `ask` (any effect) and `auto` writes go through the harness ledger:
 * a durable proposal, then `executeAction` with the proposal id as the upstream idempotency key.
 */
export interface CatalogIntegrationConfig {
  businessId: string;
  url: string;
  credential: string;
  allowInsecureLoopback?: boolean;
  /** Exact `http://<service>:<port>` origins the deployment allows without TLS (a private container network). */
  internalHttpOrigins?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  manifest: unknown;
  policy: unknown;
}

const RESERVED = 'eldhall';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.object({
  integrationId: z.string(), toolName: z.string(), operationKey: z.string(), title: z.string(),
  operationHash: hash, manifestHash: hash, policyRevision: z.number().int().positive(),
  effect: z.enum(['read', 'write']), customerId: z.string().min(1), input: z.record(z.string(), z.unknown()),
}).strict();
export type ExternalActionSnapshot = z.infer<typeof snapshotSchema>;

type Operation = Manifest['operations'][number];

export function createCatalogIntegration(config: CatalogIntegrationConfig): BusinessIntegrations {
  const manifest: Manifest = manifestSchema.parse(config.manifest);
  const url = new URL(config.url);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  const internal = url.protocol === 'http:' && (config.internalHttpOrigins ?? []).includes(url.origin);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && config.allowInsecureLoopback) && !internal)) throw new Error('MCP sidecar requires HTTPS without URL credentials/query/fragment; plain HTTP needs its exact origin in MCP_INTERNAL_HTTP_ORIGINS (or explicit loopback for tests)');
  if (!config.credential || /[\r\n]/.test(config.credential)) throw new Error('Missing or invalid MCP sidecar credential');
  const target = { url: url.href, timeoutMs: config.timeoutMs ?? 5000, credential: config.credential };
  const maxOutputBytes = config.maxOutputBytes ?? 8192;
  // Manifest and policy are fixed for this process (DB-held policy is S1-4), so each decision is computed once here
  // instead of re-validating the whole policy for every operation on every turn.
  const policy = integrationPolicySchema.safeParse(config.policy);
  const decisions = new Map<string, PermissionDecision>(manifest.operations.map(operation => [operation.operationKey, policy.success
    ? resolveWithPolicy({ businessId: config.businessId, integrationId: manifest.integrationId, manifestHash: manifest.manifestHash, operation }, policy.data)
    : { mode: 'deny', source: 'guard', matchedRuleIds: [], policyRevision: null, reasonCode: 'policy_invalid' }]));
  const decide = (operation: Operation) => decisions.get(operation.operationKey)!;
  const checkInput = (operation: Operation, input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, RESERVED)) throw new IntegrationError('invalid_input', 'Model input cannot supply identity scope');
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > 16_384) throw new Error('Input too large');
      validateToolInput(operation.inputSchema, input);
    } catch { throw new IntegrationError('invalid_input', 'Business tool input does not match the reviewed schema'); }
    return structuredClone(input as Record<string, unknown>);
  };

  return { forContext(context) {
    if (!context.businessId || !context.customerId) throw new IntegrationError('denied', 'Trusted business and customer identity required');
    const own = context.businessId === config.businessId;

    /** One sidecar session: tool advertised as expected, sidecar serves exactly our reviewed manifest, then call. */
    const dispatch = (operation: Operation, input: Record<string, unknown>, trusted: Record<string, string>, onDispatch: () => void, signal?: AbortSignal) =>
      withMcpClient(target, context, signal, async (client, options) => {
        const listing = await client.listTools(undefined, options);
        const remote = listing.tools.find(row => row.name === operation.toolName);
        const read = operation.effect === 'read';
        if (!remote || remote.annotations?.readOnlyHint !== read) throw new IntegrationError('denied', 'Sidecar does not advertise this tool with the reviewed effect');
        const loaded = toolData(await client.callTool({ name: 'get_connector_manifest', arguments: {} }, options)) as { manifestHash?: unknown; tools?: Record<string, unknown> } | null;
        if (loaded?.manifestHash !== manifest.manifestHash || loaded.tools?.[operation.toolName] !== operation.operationHash) throw new IntegrationError('denied', 'Sidecar manifest does not match the reviewed manifest');
        await context.assertActive();
        onDispatch();
        // Identity comes only from the authenticated backend context, never from model input.
        return client.callTool({ name: operation.toolName, arguments: { ...input, [RESERVED]: { ...trusted, customerId: context.customerId, businessId: context.businessId } } }, options);
      });

    const tools: BusinessTool[] = own ? manifest.operations.filter(op => decide(op).mode !== 'deny')
      .map(op => ({ integrationId: manifest.integrationId, name: op.toolName, description: op.description, inputSchema: structuredClone(op.inputSchema) })) : [];

    return {
      tools,
      async callTool(integrationId, name, input, signal) {
        const operation = own && integrationId === manifest.integrationId ? manifest.operations.find(op => op.toolName === name) : undefined;
        if (!operation) throw new IntegrationError('denied', 'Business tool is not allowlisted');
        const decision = decide(operation);
        if (decision.mode === 'deny') throw new IntegrationError('denied', `Business tool denied: ${decision.reasonCode}`);
        const clean = checkInput(operation, input);
        if (decision.mode === 'auto' && operation.effect === 'read') {
          const result = await dispatch(operation, clean, {}, () => undefined, signal);
          if (result.isError) throw new IntegrationError('unavailable', 'Business tool returned an error');
          return projectOutput(toolData(result), operation.outputFields, maxOutputBytes);
        }
        // Approval or a write needs the durable ledger; without it, fail closed.
        if (!context.propose) throw new IntegrationError('denied', 'Business action requires the support ledger');
        const snapshot: ExternalActionSnapshot = {
          integrationId: manifest.integrationId, toolName: operation.toolName, operationKey: operation.operationKey, title: operation.title,
          operationHash: operation.operationHash, manifestHash: manifest.manifestHash, policyRevision: decision.policyRevision!,
          effect: operation.effect as 'read' | 'write', customerId: context.customerId, input: clean,
        };
        return context.propose({ args: snapshot, mode: decision.mode, title: operation.title });
      },

      async executeAction(args, actionId, signal): Promise<ActionOutcome> {
        const parsed = snapshotSchema.safeParse(args);
        if (!own || !parsed.success) return { status: 'failed', reasonCode: 'invalid_snapshot' };
        const snapshot = parsed.data;
        const operation = snapshot.integrationId === manifest.integrationId ? manifest.operations.find(op => op.operationKey === snapshot.operationKey) : undefined;
        if (!operation) return { status: 'failed', reasonCode: 'operation_removed' };
        if (snapshot.customerId !== context.customerId) return { status: 'failed', reasonCode: 'scope_mismatch' };
        // Execute re-checks current rules: a policy/manifest change after approval invalidates the snapshot.
        const decision = decide(operation);
        if (decision.mode === 'deny') return { status: 'failed', reasonCode: decision.reasonCode };
        if (snapshot.operationHash !== operation.operationHash || snapshot.manifestHash !== manifest.manifestHash || snapshot.policyRevision !== decision.policyRevision || snapshot.effect !== operation.effect || snapshot.toolName !== operation.toolName) return { status: 'failed', reasonCode: 'stale_snapshot' };
        let input: Record<string, unknown>;
        try { input = checkInput(operation, snapshot.input); } catch { return { status: 'failed', reasonCode: 'invalid_input' }; }
        const write = operation.effect === 'write';
        let dispatched = false;
        try {
          const result = await dispatch(operation, input, write && operation.idempotency ? { idempotencyKey: actionId } : {}, () => { dispatched = true; }, signal);
          if (result.isError) {
            const error = (result.structuredContent ?? {}) as { error?: unknown; effect?: unknown };
            const reasonCode = typeof error.error === 'string' && /^[a-z_]{1,40}$/.test(error.error) ? error.error : 'upstream_error';
            return { status: write && error.effect !== 'none' ? 'unknown' : 'failed', reasonCode };
          }
          return { status: 'executed', data: projectOutput(toolData(result), operation.outputFields, maxOutputBytes) };
        } catch (error) {
          const reasonCode = error instanceof IntegrationError ? error.code : 'unavailable';
          // Before dispatch nothing was sent. After it, a write may have committed upstream.
          return { status: write && dispatched ? 'unknown' : 'failed', reasonCode };
        }
      },
    };
  } };
}

/** Every configured business integration: legacy read-only MCP tools plus reviewed OpenAPI catalogs. */
export function createSupportIntegrations(config: SupportConfig, env: NodeJS.ProcessEnv): BusinessIntegrations {
  const internalHttpOrigins = internalOrigins(env.MCP_INTERNAL_HTTP_ORIGINS);
  return combineIntegrations([
    { owns: config.integrations.map(row => [row.businessId, row.id] as const), integrations: createBusinessIntegrations(config, env) },
    ...config.catalogs.map(catalog => {
      const credential = env[catalog.credentialEnv];
      if (!credential) throw new Error(`Missing MCP sidecar credential environment reference: ${catalog.credentialEnv}`);
      return {
        owns: [[catalog.businessId, catalog.manifest.integrationId] as const],
        integrations: createCatalogIntegration({ businessId: catalog.businessId, url: catalog.url, credential, allowInsecureLoopback: catalog.allowInsecureLoopback, internalHttpOrigins,
          timeoutMs: catalog.timeoutMs, maxOutputBytes: catalog.maxOutputBytes, manifest: catalog.manifest, policy: catalog.policy }),
      };
    }),
  ]);
}

/** MCP_INTERNAL_HTTP_ORIGINS: JSON array of exact `http://<service>:<port>` origins; anything else stops startup. */
function internalOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!Array.isArray(parsed) || parsed.length > 10 || parsed.some(origin => typeof origin !== 'string' || !INTERNAL_SERVICE_ORIGIN.test(origin))) {
    throw new Error('MCP_INTERNAL_HTTP_ORIGINS must be a JSON array of http://<service>:<port> origins');
  }
  return parsed as string[];
}
