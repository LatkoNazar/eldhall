# Integration manifest and permissions contract

Stages A–B of [TODO.md](../TODO.md). It fixes the formats that the Python OpenAPI importer (`apps/mcp-openapi/`) and the TypeScript backend share.

**Implemented and tested:**
- TS side:
  - manifest validation (`apps/api/src/integrations/manifest.ts`);
  - the permission resolver (`permissions.ts`);
  - `createCatalogIntegration` (`catalog.ts`), which executes `auto` reads through the sidecar.
- Python side: the importer and the scoped sidecar (`apps/mcp-openapi`).

**Not wired yet:**
- harness/factory registration;
- `ask` proposals and writes (Stage C), which fail closed with `denied`;
- DB-held policy and the admin API (Stage D);
- mapping Eldhall customer ids to upstream ids: today the backend's `customerId` is sent as is.

Reference fixture: [`examples/orders/`](../examples/orders/). It contains a synthetic OpenAPI file, the matching manifest and policy, and a mock upstream API (`mock-api.mjs`) that enforces customer ownership.

## Canonical hashing

`sha256` over the UTF-8 bytes of canonical JSON:

- object keys sorted by code point;
- no whitespace;
- non-ASCII characters left unescaped;
- the object's own hash field omitted.

| Language | Implementation |
|---|---|
| TypeScript | `fingerprint(value, omit)` |
| Python | `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` |

The importer must emit integral numbers as integers. Python's `1.0` and JavaScript's `1` serialize differently, so a float like `1.0` changes the hash.

| Hash | Covers |
|---|---|
| `specHash` | The imported OpenAPI document as parsed JSON |
| `operationHash` | Every field of the operation except `operationHash` |
| `manifestHash` | Every field of the manifest, including all operations and their hashes, except `manifestHash` |

Reformatting or reordering keys does not change any of these hashes. Any change to a schema, mapping, scope, output field, tag or adapter does.

## Manifest (`schemaVersion: 1`, `adapterContractVersion: 1`)

Header fields:
- `schemaVersion`
- `generatorVersion`
- `adapterContractVersion`
- `integrationId`
- `specHash`
- `operations[]`
- `manifestHash`

Each operation has the following fields.

| Field | Rule |
|---|---|
| `operationKey` | `"METHOD /path/template"`, unique within the integration. Full identity is `businessId + integrationId + operationKey`. |
| `operationId` | From the spec, or `null`. Never used as the identity. |
| `toolName` | Deterministic MCP name, unique within the integration. |
| `method`, `path`, `title`, `description`, `tags` | Exact values from the spec. `tags` define the groups. |
| `effect` | `read`, `write` or `unknown`. The importer emits `unknown` until a reviewer sets the value; an `unknown` operation never executes. |
| `inputSchema` | Model-facing input, bounded to the same subset as `schema.ts`: `additionalProperties: false`, depth ≤ 5. |
| `parameters` | Exactly one location (`path`, `query` or `body`) for every input property. Model input can never become a header. |
| `scope.customerId` (required), `scope.businessId` (optional) | Trusted values injected by the backend: `{in: path\|query\|body\|header, name}`. They must not appear in `inputSchema`. |
| path template | Every `{param}` is mapped exactly once, either from a required input or from scope. |
| `outputFields` | Approved flat fields. Anything else from upstream is dropped; see `internal_note` in the fixture. |
| `guard` | Id of a registered adapter guard, e.g. `orders.cancel_before_shipment`, or `null`. Never code. |
| `idempotency` | `{header}` for writes whose upstream deduplicates. |
| `reconciliation` | `{operationKey}` of a read used to resolve `unknown` outcomes. |

## Permission policy

The schema is `integrationPolicySchema`; [`examples/orders/policy.json`](../examples/orders/policy.json) is an example. `resolvePermission()` returns `{mode, source, matchedRuleIds, policyRevision, reasonCode}`. It applies these steps in order and stops at the first that matches:

1. The result is `deny` (source `guard`) when any of the following holds:
   - the policy is invalid (`policy_invalid`);
   - the business or integration does not match;
   - the integration is disabled;
   - the manifest hash differs;
   - the operation is disabled or missing from the policy;
   - `reviewedOperationHash` is not equal to the current `operationHash`;
   - the effect is `unknown`.
2. An explicit operation rule (`auto`, `ask` or `deny`) applies.
3. If the operation rule is `inherit`, the explicit rules of all matching groups apply, and the strictest wins: `deny > ask > auto`. A group selects operations by an exact `tag` or by an explicit `operationKeys` list.
4. If no group matches, `defaultMode` applies. It cannot be `inherit`, and it starts as `deny`.

Integration or group `auto` never enables an operation that is new, changed or unreviewed. Absolute business guards, scope and ownership checks run outside the resolver, and no rule overrides them.

## Import and sidecar (Stage B)

Importer:

```bash
cd apps/mcp-openapi
uv run support-mcp-import ../../examples/orders/openapi.json ../../examples/orders/review.json \
  --out ../../examples/orders/manifest.json --report report.json --previous old-manifest.json
uv run python -m unittest discover -s tests
```

How the importer works:
- **Inputs.** It reads a local OpenAPI 3.0.x/3.1.x JSON file and a deployment-owned `review.json`. For each operation, the review supplies the effect, scope, `outputFields`, guard, idempotency and reconciliation settings.
- **Unreviewed operations.** Operations without a review entry are reported as `unreviewed` and left out of the manifest.
- **Unsupported constructs.** These are reported as `unsupported` and never widened:
  - `oneOf`/`anyOf`/`allOf`;
  - remote or cyclic `$ref`;
  - binary or non-JSON bodies;
  - open-ended objects;
  - required non-scope headers.
- **Repeat imports.** `--previous` adds an added/changed/unchanged/removed diff of the operations.
- **Fixture.** The committed fixture manifest is the importer's own output, and a test checks that it reproduces exactly.

Sidecar:
- **Implementation.** FastMCP 4, Streamable HTTP on `/mcp`, plus an open `/health`.
- **Tools.** It registers one tool per manifest operation with effect `read` or `write`, built explicitly from the manifest. `FastMCP.from_openapi()` is not used because it would expose every route. It also serves a backend-only `get_connector_manifest` tool.
- **Authentication.** Every MCP request needs the service bearer `MCP_SERVICE_TOKEN`.
- **Upstream.** The upstream target comes only from `UPSTREAM_BASE_URL` and `UPSTREAM_TOKEN`; the spec's `servers` field is ignored. Redirects are off.
- **Trusted scope.** It arrives in the reserved `eldhall` argument (`customerId`, `businessId?`, `idempotencyKey?`), which no manifest input may use.
- **Errors.** Upstream errors become `{error, effect: none|unknown}`. Raw bodies and headers are never returned. A write that times out or gets a 5xx returns `effect: unknown`.

TS boundary, in the order of checks:
1. The resolver decides `auto`, `ask` or `deny`.
2. Input is checked against the reviewed schema; the reserved `eldhall` key and scope fields are rejected.
3. The sidecar must advertise the tool as read-only.
4. `get_connector_manifest` must return the same `manifestHash` and `operationHash`.
5. The call goes out with backend scope.
6. The output is projected to `outputFields`.

To run the end-to-end check (mock upstream ← real sidecar ← TS catalog), you need `uv`:

```bash
cd apps/api && npm run test:mcp-openapi
```

## Planned next contracts (Stage C, not implemented)

- **Dispatcher result.** The model receives one of these: `executed{actionId?, data}`, `awaiting_approval{proposalId, summary}`, `denied{reasonCode}`, `failed{actionId?, reasonCode}` or `unknown{actionId, reasonCode}`.
- **Proposal snapshot.** The snapshot holds:
  - business, customer and case;
  - `integrationId`, `operationKey`, `operationHash` and `manifestHash`;
  - connection revision and policy revision;
  - effect and normalized arguments, including injected scope;
  - decision source, expiry and guard results.

  The snapshot is immutable; any change requires a new proposal. Approve stays a separate step from execute.
- **Execution record.** The record is keyed by a durable `actionId`, which is also the upstream idempotency key. It stores origin (`operator_approval` or `policy_auto`), status, attempts, provider reference and a bounded result.
