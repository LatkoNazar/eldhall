import { z } from 'zod';
import { fingerprint } from './permissions.js';
import { safeKey, validateInputSchema, type InputSchema } from './schema.js';

/**
 * Normalized OpenAPI → MCP catalog (TODO.md §4.1), produced by the Python importer and verified here.
 * Contract details and the canonical hashing rules: docs/integrations-manifest.md.
 */
export const MANIFEST_SCHEMA_VERSION = 1;
export const ADAPTER_CONTRACT_VERSION = 1;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const path = z.string().regex(/^\/[A-Za-z0-9._~\-/{}]{0,499}$/);
const field = z.string().refine(safeKey, 'Expected a safe identifier');
const header = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const location = z.enum(['path', 'query', 'body']);
const protectedHeaders = new Set(['authorization','proxy-authorization','host','content-length','transfer-encoding','connection','cookie','set-cookie','content-type','accept']);
// Header placement is allowed for trusted scope only; model input never sets headers.
const scopeBinding = z.union([z.object({ in: location, name: field }).strict(), z.object({ in: z.literal('header'), name: header }).strict()]);

const operationSchema = z.object({
  operationKey: z.string(),
  operationId: z.string().min(1).max(128).nullable(),
  toolName: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  method,
  path,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  tags: z.array(z.string().min(1).max(100)).max(20),
  // `unknown` is legal in an import/review report; the resolver never executes it.
  effect: z.enum(['read', 'write', 'unknown']),
  inputSchema: z.custom<InputSchema>(value => {
    try { validateInputSchema(value); return value.type === 'object'; } catch { return false; }
  }, 'Expected a bounded object JSON Schema'),
  parameters: z.record(field, location),
  scope: z.object({ businessId: scopeBinding.optional(), customerId: scopeBinding }).strict(),
  outputFields: z.array(field).min(1).max(30),
  guard: z.string().regex(/^[a-z0-9_.-]{1,100}$/).nullable(),
  idempotency: z.object({ header }).strict().nullable(),
  reconciliation: z.object({ operationKey: z.string() }).strict().nullable(),
  operationHash: hash,
}).strict().superRefine((op, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message: `${op.operationKey}: ${message}` });
  if(op.path.startsWith('//') || op.path.split('/').some(segment=>segment==='.'||segment==='..')) issue('literal dot segments and authority paths are forbidden');
  const names=[...op.path.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]!);
  if(/[{}]/.test(op.path.replace(/\{[^{}]+\}/g,'')) || names.some(name=>!safeKey(name)) || new Set(names).size!==names.length) issue('invalid or duplicate path placeholders');
  if(op.toolName==='get_connector_manifest') issue('reserved toolName');
  if (op.operationKey !== `${op.method} ${op.path}`) issue('operationKey must be "METHOD /path"');
  if (!op.inputSchema || typeof op.inputSchema !== 'object') return;
  const inputs = Object.keys(op.inputSchema.properties ?? {});
  const mapped = Object.keys(op.parameters);
  if (inputs.length !== mapped.length || inputs.some(name => !Object.hasOwn(op.parameters, name))) issue('every model input needs exactly one parameter mapping');
  const scope = Object.values(op.scope).filter(binding => binding !== undefined);
  const destinations=scope.map(binding=>`${binding.in}/${binding.in==='header'?binding.name.toLowerCase():binding.name}`);
  if(new Set(destinations).size!==destinations.length) issue('scope destinations must be distinct');
  if(scope.some(binding=>binding.in==='header'&&protectedHeaders.has(binding.name.toLowerCase()))) issue('scope cannot override protected headers');
  if (scope.some(binding => inputs.includes(binding.name))) issue('scope fields must be excluded from model inputSchema');
  const pathParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);
  const pathSources = [...mapped.filter(name => op.parameters[name] === 'path'), ...scope.filter(binding => binding.in === 'path').map(binding => binding.name)];
  if (pathParams.length !== pathSources.length || pathParams.some(name => !pathSources.includes(name))) issue('path template parameters must match path mappings');
  for (const name of pathParams) if (mapped.includes(name) && !op.inputSchema.required?.includes(name)) issue(`path parameter ${name} must be required`);
  if (op.effect === 'read' && op.idempotency) issue('idempotency applies to writes only');
  if(op.idempotency && (protectedHeaders.has(op.idempotency.header.toLowerCase())||destinations.includes(`header/${op.idempotency.header.toLowerCase()}`))) issue('idempotency header collision');
  if(op.guard!==null&&op.guard!=='orders.cancel_before_shipment') issue('unknown adapter guard');
  if(op.guard==='orders.cancel_before_shipment'&&(op.effect!=='write'||!op.idempotency||!op.reconciliation||op.inputSchema.properties?.order_id?.type!=='string')) issue('orders cancel guard requires a write with order_id, idempotency and reconciliation');
  if(new Set(op.outputFields).size!==op.outputFields.length) issue('duplicate output projection field');
  if (fingerprint(op, 'operationHash') !== op.operationHash) issue('operationHash does not match canonical content');
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  generatorVersion: z.string().min(1).max(100),
  adapterContractVersion: z.literal(ADAPTER_CONTRACT_VERSION),
  integrationId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  specHash: hash,
  operations: z.array(operationSchema).max(1000),
  manifestHash: hash,
}).strict().superRefine((manifest, ctx) => {
  const keys = manifest.operations.map(op => op.operationKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate operationKey' });
  if (new Set(manifest.operations.map(op => op.toolName)).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate toolName' });
  const ids=manifest.operations.map(op=>op.operationId).filter(id=>id!==null);
  if(new Set(ids).size!==ids.length) ctx.addIssue({code:'custom',message:'Duplicate operationId'});
  for (const op of manifest.operations) if (op.reconciliation && !keys.includes(op.reconciliation.operationKey)) ctx.addIssue({ code: 'custom', message: `${op.operationKey}: unknown reconciliation operation` });
  for(const op of manifest.operations) if(op.reconciliation) {
    const target=manifest.operations.find(candidate=>candidate.operationKey===op.reconciliation!.operationKey);
    if(!target||target.effect!=='read'||target.guard!==null) ctx.addIssue({code:'custom',message:`${op.operationKey}: reconciliation must name an unguarded read`});
    if(op.guard==='orders.cancel_before_shipment'&&target&&(target.inputSchema.properties?.order_id?.type!=='string'||fingerprint(target.scope)!==fingerprint(op.scope)||!target.outputFields.includes('status')||!target.outputFields.includes('order_id'))) ctx.addIssue({code:'custom',message:`${op.operationKey}: cancel guard needs a scoped order-status read`});
  }
  if (fingerprint(manifest, 'manifestHash') !== manifest.manifestHash) ctx.addIssue({ code: 'custom', message: 'manifestHash does not match canonical content' });
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestOperation = Manifest['operations'][number];
