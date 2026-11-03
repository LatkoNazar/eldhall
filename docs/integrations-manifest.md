# Integration manifest and permissions contract

Stages A–C of [TODO.md](../TODO.md). It fixes the formats that the Python OpenAPI importer (`apps/mcp-openapi/`) and the TypeScript backend share.

**Implemented and tested:**
- TS side:
  - manifest validation (`apps/api/src/integrations/manifest.ts`);
  - the permission resolver (`permissions.ts`);
  - `createCatalogIntegration` (`catalog.ts`), which runs `auto` reads inline and routes `ask` and writes through the harness proposal ledger;
  - wiring: `catalogs` in the support config file, loaded by `factory.ts` through `createSupportIntegrations`, which serves legacy read-only MCP integrations and catalogs side by side and routes every call by business + `integrationId`.
- Python side: the importer and the scoped sidecar (`apps/mcp-openapi`).

**Not wired yet:**
- a container image and Compose overlay for the sidecar (S1-2);
- `ask` proposals and writes outside a support turn (no ledger), which fail closed with `denied`;
- DB-held policy and the admin API (Stage D);
- mapping Eldhall customer ids to upstream ids: today the backend's `customerId` is sent as is.

Reference fixture: [`examples/orders/`](../examples/orders/). It contains a synthetic OpenAPI file, the matching manifest and policy, and a mock upstream API (`mock-api.mjs`) that enforces customer ownership.

## Configuration (S1-1)

A catalog is one entry of `catalogs` in the operator-controlled support config (`SUPPORT_CONFIG_FILE`). The reviewed manifest and policy are embedded, so the single read-only config mount carries them; the sidecar credential is named, never stored:

```json
{ "catalogs": [{
  "businessId": "<business uuid>",
  "url": "https://mcp-openapi.internal/mcp",
  "credentialEnv": "ORDERS_SIDECAR_TOKEN",
  "timeoutMs": 5000,
  "manifest": { "...": "importer output (manifest.json)" },
  "policy": { "...": "policy.json with the same businessId and manifestHash" }
}] }
```

Startup refuses a catalog whose manifest hashes do not verify, whose policy belongs to another business or integration or was reviewed against another `manifestHash`, whose `integrationId` repeats within the business (legacy MCP integrations included), or whose credential variable is missing. Changing the manifest or policy currently means editing this file and restarting; the database-held policy with optimistic revisions is S1-4. `url` follows the same rule as legacy MCP: HTTPS, or loopback HTTP with `allowInsecureLoopback` for tests; an internal-origin allowlist for the Compose network comes with S1-2.

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
- **Path values.** Values placed into the path are percent-encoded as one segment; `""`, `.` and `..` are rejected (`invalid_path_value`), because HTTP clients normalize dot segments and `/orders/../cancel` would reach `/cancel`.
- **Timeouts.** `UPSTREAM_TIMEOUT_SECONDS` (default 4 s) must stay below the backend's MCP call timeout (`timeoutMs`, default 5 s). Otherwise a slow upstream success arrives after the backend gave up and is recorded as `unknown`.
- **Trusted scope.** It arrives in the reserved `eldhall` argument (`customerId`, `businessId?`, `idempotencyKey?`), which no manifest input may use.
- **Errors.** Upstream errors become `{error, effect: none|unknown}`. Raw bodies and headers are never returned. A write that times out, gets a 5xx, a 3xx (redirects are not followed; POST-redirect-GET may follow a committed write) or a 408 returns `effect: unknown`. Other 4xx responses are confirmed rejections (`effect: none`). The upstream call has a total deadline (`asyncio.wait_for`), not only per-phase httpx timeouts.

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

## External actions (Stage C)

`ask` operations of any effect, and `auto` writes, go through the existing proposal ledger as `tool: "external_action"`. They need no new tables.

**Snapshot.** The proposal `args` are the immutable `ExternalActionSnapshot`:
- `integrationId`, `toolName`, `operationKey` and `title`;
- `operationHash`, `manifestHash` and `policyRevision`;
- `effect`;
- `customerId`;
- the normalized `input`.

`argsHash` covers all of it. An approval therefore binds to the exact operation, arguments and versions.

**During the turn**, the catalog calls the harness `propose` callback:
- `ask` creates a `pending` proposal. The model gets `awaiting_approval`, and the customer gets a server-composed "prepared, a specialist must confirm" reply. The model's own text is not used.
- `auto` creates the proposal, claims it (`agent:auto`) and executes it immediately through the same path.

**One action per turn.** The model may make at most one external action per durable turn. The unique `(turn_job_id, tool)` key enforces this in the DB across retries. A repeat with the same arguments returns the same proposal, and a different action returns `denied: one_external_action_per_turn`. Proposals within one turn are serialized, so parallel tool calls cannot race past this check (inline mode has no durable turn key). An in-turn `auto` dispatch runs the turn's ownership fence right before sending; a takeover stops it with nothing sent.

**Reply guard.** Model prose that claims an action was performed ("I cancelled…", "cancelled successfully", "Скасування підтверджено") is always replaced; only server templates from a recorded proposal may say so. A claim about a resulting state ("your order is cancelled") is kept only when business data returned in this turn shows that state. The upstream `status` quoted in the "done" template is limited to a short plain token.

**Approve and execute.**
- **Approve** stores consent only.
- **Execute** first takes the atomic `claimExecution` claim, which holds the 15-minute approval TTL and lets only one of several concurrent requests win.
- `executeAction` then re-checks the snapshot against the current manifest, policy revision, effect and customer, and fails with `stale_snapshot` or `scope_mismatch` before anything is dispatched.
- The proposal id is the upstream idempotency key, so a delivery retry replays and does not run twice.

**Outcomes.**

| Proposal status | When |
|---|---|
| `executed` | The result was recorded first; only then does the customer get the "done" template. |
| `failed` | Confirmed no effect: an upstream 4xx, a guard such as already shipped, or a failure before dispatch. |
| `unknown` | A write was dispatched, then timed out, hit a 5xx/3xx/408, failed transport, or the executor crashed. The case moves to staff and execution stays locked for reconciliation. |

Origin is recorded in the audit as `operator_approval` or `policy_auto`. Takeover and stale `executing` recovery reuse the existing proposal rules.

**Verification.**

| Check | Covers | Run here? |
|---|---|---|
| `tests/external-actions.test.ts` (memory store) | the ledger states | yes |
| `npm run test:mcp-openapi` | real sidecar: execution, idempotent replay, the shipped-order guard, stale policy, foreign scope | yes |
| A new case in `tests/postgres-store.integration.ts` | concurrent execute and the `external_action`-only auto claim | yes, in the CI `integration` job (`npm run test:postgres`) |

**Gaps.**
- No admin API or UI shows external actions or edits policy; Stage D will add them.
- `unknown` outcomes are resolved by hand; automatic reconciliation through `reconciliation.operationKey` is not implemented yet.
- Expired approvals simply cannot be executed; they get no explicit terminal state.
- Eldhall customer ids reach the upstream unmapped.
