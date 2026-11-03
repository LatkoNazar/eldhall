import { manifestSchema, type Manifest } from './manifest.js';
import { IntegrationError, projectOutput, toolData, withMcpClient, type BusinessIntegrations, type BusinessTool } from './mcp.js';
import { resolvePermission } from './permissions.js';
import { validateToolInput } from './schema.js';

/**
 * Manifest-backed business tools served by the Python sidecar (apps/mcp-openapi). TODO.md Stage B:
 * only `auto` reads execute here; `ask` and writes fail closed until the proposal/ledger path (Stage C) exists.
 */
export interface CatalogIntegrationConfig {
  businessId: string;
  url: string;
  credential: string;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  manifest: unknown;
  policy: unknown;
}

const RESERVED = 'eldhall';

export function createCatalogIntegration(config: CatalogIntegrationConfig): BusinessIntegrations {
  const manifest: Manifest = manifestSchema.parse(config.manifest);
  const url = new URL(config.url);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && config.allowInsecureLoopback))) throw new Error('MCP sidecar requires HTTPS without URL credentials/query/fragment; explicit loopback HTTP is available for tests');
  if (!config.credential || /[\r\n]/.test(config.credential)) throw new Error('Missing or invalid MCP sidecar credential');
  const target = { url: url.href, timeoutMs: config.timeoutMs ?? 5000, credential: config.credential };
  const maxOutputBytes = config.maxOutputBytes ?? 8192;
  const decide = (operation: Manifest['operations'][number]) => resolvePermission({ businessId: config.businessId, integrationId: manifest.integrationId, manifestHash: manifest.manifestHash, operation }, config.policy);

  return { forContext(context) {
    if (!context.businessId || !context.customerId) throw new IntegrationError('denied', 'Trusted business and customer identity required');
    const own = context.businessId === config.businessId;
    // `deny` operations are not advertised; the call path re-checks anyway.
    const tools: BusinessTool[] = own ? manifest.operations.filter(op => decide(op).mode !== 'deny')
      .map(op => ({ integrationId: manifest.integrationId, name: op.toolName, description: op.description, inputSchema: structuredClone(op.inputSchema) })) : [];
    return {
      tools,
      async callTool(integrationId, name, input, signal) {
        const operation = own && integrationId === manifest.integrationId ? manifest.operations.find(op => op.toolName === name) : undefined;
        if (!operation) throw new IntegrationError('denied', 'Business tool is not allowlisted');
        const decision = decide(operation);
        if (decision.mode === 'deny') throw new IntegrationError('denied', `Business tool denied: ${decision.reasonCode}`);
        if (decision.mode === 'ask') throw new IntegrationError('denied', 'Business tool requires operator approval; approval flow is not wired yet');
        if (operation.effect !== 'read') throw new IntegrationError('denied', 'Write execution requires the action ledger; not wired yet');
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, RESERVED)) throw new IntegrationError('invalid_input', 'Model input cannot supply identity scope');
        try {
          if (Buffer.byteLength(JSON.stringify(input)) > 16_384) throw new Error('Input too large');
          validateToolInput(operation.inputSchema, input);
        } catch { throw new IntegrationError('invalid_input', 'Business tool input does not match the reviewed schema'); }

        return withMcpClient(target, context, signal, async (client, options) => {
          const listing = await client.listTools(undefined, options);
          const remote = listing.tools.find(row => row.name === name);
          if (!remote || remote.annotations?.readOnlyHint !== true) throw new IntegrationError('denied', 'Sidecar does not advertise this read tool');
          // Sidecar must serve exactly the manifest we reviewed; a stale or swapped catalog fails closed.
          const loaded = toolData(await client.callTool({ name: 'get_connector_manifest', arguments: {} }, options)) as { manifestHash?: unknown; tools?: Record<string, unknown> } | null;
          if (loaded?.manifestHash !== manifest.manifestHash || loaded.tools?.[name] !== operation.operationHash) throw new IntegrationError('denied', 'Sidecar manifest does not match the reviewed manifest');
          await context.assertActive();
          // Identity comes only from the authenticated backend context, never from model input.
          const args = { ...structuredClone(input), [RESERVED]: { customerId: context.customerId, businessId: context.businessId } };
          const result = await client.callTool({ name, arguments: args }, options);
          if (result.isError) throw new IntegrationError('unavailable', 'Business tool returned an error');
          return projectOutput(toolData(result), operation.outputFields, maxOutputBytes);
        });
      },
    };
  } };
}
