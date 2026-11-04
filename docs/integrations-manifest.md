# Integration manifest and permissions contract

This is the permanent contract shared by the Python OpenAPI importer (`apps/mcp-openapi/`) and the TypeScript backend. Follow the [installation and activation walkthrough](OPENAPI_QUICKSTART.md) to connect an existing API.

**Implemented and tested:**
- TS side:
  - manifest validation (`apps/api/src/integrations/manifest.ts`);
  - the permission resolver (`permissions.ts`);
  - `createCatalogIntegration` (`catalog.ts`), which runs `auto` reads inline and routes `ask` and writes through the harness proposal ledger;
  - wiring: `catalogs` in the support config file, loaded by `factory.ts` through `createSupportIntegrations`, which serves legacy read-only MCP integrations and catalogs side by side and routes every call by business + `integrationId`.
- Python side: the importer and the scoped sidecar (`apps/mcp-openapi`).

The production factory uses PostgreSQL-held policy, review and activation state. The operator API and Integrations UI manage these with optimistic revisions. A deployment-controlled customer ID map is optional; if configured, missing mappings deny execution. Calls that require a proposal outside a support turn (without a ledger) fail closed.

Reference fixture: [`examples/orders/`](../examples/orders/). It contains a synthetic OpenAPI file, the matching manifest and policy, and a mock upstream API (`mock-api.mjs`) that enforces customer ownership.

## Configuration (S1-1)

A catalog is one entry of `catalogs` in the operator-controlled support config (`SUPPORT_CONFIG_FILE`). The reviewed manifest and policy are embedded, so the single read-only config mount carries them; the sidecar credential is named, never stored:

```json
{ "catalogs": [{
  "businessId": "<business uuid>",
  "url": "https://mcp-openapi.internal/mcp",
  "credentialEnv": "ORDERS_SIDECAR_TOKEN",
  "connectionRevision": "1",
  "upstreamTargetFingerprint": "<sha256 of normalized upstream URL and nonsecret principal label>",
  "timeoutMs": 5000,
  "manifest": { "...": "importer output (manifest.json)" },
  "policy": { "...": "policy.json with the same businessId and manifestHash" }
}] }
```

Startup refuses a catalog whose manifest hashes do not verify, whose bootstrap policy belongs to another business or integration or names another `manifestHash`, whose `integrationId` repeats within the business (legacy MCP integrations included), or whose credential variable is missing. First import is disabled and unreviewed with default deny. The file never overwrites operator edits or re-enables revoked access. A catalog or connection change requires disable/drain, matching deployment artifacts and process restart followed by review and activation. Policy-only changes use the operator API and take effect from the shared database. `url` must be HTTPS, loopback HTTP with `allowInsecureLoopback` for tests, or plain HTTP to a private service origin that the deployment allowlists exactly (see the Compose section below).

`connectionRevision` is a positive decimal string, default `"1"`. Increase it for an endpoint, credential principal reference or trusted identity mapping change. `customerIdMap` maps authenticated support customer IDs to upstream IDs; `upstreamBusinessId` optionally maps the business. The connection fingerprint excludes secret values. An old revision cannot restore a newer target mapping.

`upstreamTargetFingerprint` binds the sidecar's actual deployment URL and nonsecret principal label: SHA-256 of canonical `{baseUrl,principalId}`, where the parsed URL omits trailing slashes. The generator computes it from `--upstream-url` and `--upstream-principal`. The sidecar reports the same fingerprint plus `MCP_CONNECTION_REVISION`; readiness and every invocation verify both. `MCP_UPSTREAM_PRINCIPAL_ID` must identify the upstream account selected by the secret; opaque token introspection is outside this adapter.

## Canonical hashing

`sha256` over the UTF-8 bytes of canonical JSON:

- object keys sorted by UTF-16 code units;
- no whitespace;
- non-ASCII characters left unescaped;
- the object's own hash field omitted.

| Language | Implementation |
|---|---|
| TypeScript | `fingerprint(value, omit)` |
| Python | RFC 8785 `rfc8785.dumps(value)` |

Number encoding matches ECMAScript JSON, including integral floats and exponent formatting. Nonfinite and non-interoperable integers are rejected. Operations are ordered deterministically by supported method rank (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) and path; object-key reordering therefore never reorders the catalog.

| Hash | Covers |
|---|---|
| `specHash` | The normalized local OpenAPI artifact with expanded local refs |
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
  - binary or non-JSON bodies;
  - open-ended objects;
  - required non-scope headers.
- **Invalid references.** Remote or cyclic refs, excessive expansion and malformed JSON reject the whole local import before any executable artifact is published.
- **Artifacts.** The command writes the manifest, normalized OpenAPI and optional review report. `--normalized-spec` selects the normalized artifact path; its default is `<manifest stem>.normalized.openapi.json`.
- **Repeat imports.** `--previous` adds an added/changed/unchanged/removed diff of the operations.
- **Fixture.** The committed fixture manifest is the importer's own output, and a test checks that it reproduces exactly.

Sidecar:
- **Implementation.** FastMCP 4, Streamable HTTP on `/mcp`, plus an open `/health`.
- **Tools.** Import mechanically compiles a candidate inventory through `FastMCP.from_openapi()` with only reviewed non-unknown routes and a deny-I/O client. Runtime registers bounded reviewed wrappers for those operations; no unreviewed generated route becomes executable. A backend-only `get_connector_manifest` tool reports the catalog and contract fingerprints. Activation and every call verify exact schemas as well as hashes.
- **Guards.** Named guards must exist in the code registry; unknown names fail startup. `orders.cancel_before_shipment` performs a scoped status read before dispatch; the upstream must still atomically enforce ownership, cancellation state and idempotency. An already cancelled order may only reach upstream to resolve its reviewed idempotency key, not to bypass the upstream state guard.
- **Authentication.** Every MCP request needs the service bearer `MCP_SERVICE_TOKEN`.
- **Upstream.** The upstream target comes only from `UPSTREAM_BASE_URL` and `UPSTREAM_TOKEN`; the spec's `servers` field is ignored. Redirects are off.
- **Path values.** Values placed into the path are percent-encoded as one segment; `""`, `.` and `..` are rejected (`invalid_path_value`), because HTTP clients normalize dot segments and `/orders/../cancel` would reach `/cancel`.
- **Timeouts.** `UPSTREAM_TIMEOUT_SECONDS` (default 4 s) must stay below the backend's MCP call timeout (`timeoutMs`, default 5 s). Otherwise a slow upstream success arrives after the backend gave up and is recorded as `unknown`.
- **Trusted scope.** It arrives in the reserved `eldhall` argument (`customerId`, `businessId?`, `idempotencyKey?`), which no manifest input may use.
- **Errors.** Upstream errors become `{error, effect: none|unknown}`. Raw bodies and headers are never returned. A write that times out, gets a 5xx, a 3xx (redirects are not followed; POST-redirect-GET may follow a committed write) or a 408 returns `effect: unknown`. Other 4xx responses are confirmed rejections (`effect: none`). The upstream call has a total deadline (`asyncio.wait_for`), not only per-phase httpx timeouts.

TS boundary, in the order of checks:
1. The resolver decides `auto`, `ask` or `deny`.
2. Input is checked against the reviewed schema; the reserved `eldhall` key and scope fields are rejected.
3. The sidecar must advertise the reviewed effect and exact tool input schema, including reserved trusted scope.
4. `get_connector_manifest` must return the same `manifestHash`, `operationHash` and adapter contract version.
5. The call goes out with backend scope.
6. The output is projected to `outputFields`.

To run the end-to-end check (mock upstream ← real sidecar ← TS catalog), you need `uv`:

```bash
cd apps/api && npm run test:mcp-openapi
```

## Running the sidecar with Docker Compose (S1-2)

`deploy/support.mcp.compose.yaml` adds the sidecar (`apps/mcp-openapi/Dockerfile`) to the self-host support stack:

```bash
docker compose --env-file .env.support -f deploy/support.compose.yaml -f deploy/support.config.compose.yaml \
  -f deploy/support.mcp.compose.yaml up -d --build --wait
```

Add to the private `.env.support` (never commit it):

| Variable | Meaning |
|---|---|
| `MCP_SERVICE_TOKEN` | Bearer shared by api, worker and the sidecar, at least 16 characters. Use `"credentialEnv": "MCP_SERVICE_TOKEN"` in the catalog. |
| `MCP_UPSTREAM_BASE_URL` | Base URL of the business API the sidecar calls. The spec's `servers` field is ignored. |
| `MCP_UPSTREAM_TOKEN` | Optional bearer for that API. |
| `MCP_UPSTREAM_PRINCIPAL_ID` | Nonsecret label of the credential's upstream principal, default `default`; must match the reviewed target fingerprint. |
| `MCP_CONNECTION_REVISION` | Reviewed positive decimal revision, default `1`; must match the catalog. |
| `MCP_UPSTREAM_ALLOW_INSECURE_HTTP` | Default `false`. Plain `http://` is accepted only for a single-label service name or loopback; set `true` only for a trusted private network. |
| `MCP_MEMORY_LIMIT` | Sidecar memory limit, default `256m`; `pids_limit` is 128. |
| `MCP_UPSTREAM_TIMEOUT_SECONDS` | Total upstream deadline, default 4. It must stay below the catalog's `timeoutMs`. |
| `MCP_MANIFEST_PATH` | The reviewed `manifest.json`, bind-mounted read-only. |
| `SUPPORT_CONFIG_PATH` | The support config. Its catalog embeds the same manifest and uses `"url": "http://mcp-openapi:8000/mcp"`. |

What the overlay enforces:

**Network**
- The sidecar publishes no port and sits on its own `mcp` network. Only api and worker join that network, so the sidecar, which holds the upstream token, has no route to postgres or redis.
- Plain HTTP is accepted only for the exact origin `http://mcp-openapi:8000`. The overlay sets this on api and worker through `MCP_INTERNAL_HTTP_ORIGINS`.
- Every other MCP target still needs HTTPS.
- Legacy MCP integrations stay HTTPS-only.

**Request checks**
- The sidecar answers only to `Host: mcp-openapi` or a localhost name. Any other Host gets 421, which protects against DNS rebinding.
- Every MCP request needs the service bearer.
- `/health` is open and reports the loaded manifest hash.

**Container hardening**
- Non-root user (uid 10001).
- Read-only filesystem.
- No capabilities.
- `no-new-privileges`.
- Dependencies installed from `uv.lock`.

**Consistency checks**
- api and worker start only after the sidecar is healthy.
- The backend still verifies the manifest hashes on every call. A sidecar serving a different manifest fails closed.

**Error handling and secrets**
- A misconfigured sidecar exits with `MCP sidecar configuration invalid: <reason>`. The reason names settings, never values.
- Secrets are plain container environment variables, the same as for the rest of the stack. Anyone with Docker access on the host can read them with `docker inspect`. File-based Docker secrets are a possible hardening step.

**Several catalogs.** One sidecar serves one manifest. A second catalog needs a second sidecar service with its own name, manifest and upstream, and its origin added to `MCP_INTERNAL_HTTP_ORIGINS`.

**Smoke.** CI job `sidecar-compose` builds the images and starts this exact composition, plus `deploy/smoke/support.mcp.smoke.compose.yaml`. That overlay adds a synthetic Orders upstream and a scripted OpenAI-compatible model. CI then runs `scripts/mcp-sidecar-smoke.mjs`, which checks:
- chat → worker → DSH → `call_business_tool` → sidecar → upstream → reply;
- that one customer cannot read another customer's order;
- that `ask` → approve → execute changes the upstream exactly once (the mock counts writes), and a second execute is refused and sends nothing.

The job gates `deploy` together with ordinary checks and PostgreSQL/cross-language integration tests. Release bundles contain the sidecar image, Compose overlays, scripts and versioned example artifacts; private deployment configuration and credentials remain explicit mounts.

The smoke overlay is for tests only: it contains a mock with a test-control route.

## External actions (Stage C)

`ask` operations of any effect, and `auto` writes, go through proposals as `tool: "external_action"`, with integration state, immutable manifests and the execution ledger added by migration `0008_integrations.sql`.

**Snapshot.** The proposal `args` are the immutable `ExternalActionSnapshot`:
- `integrationId`, `toolName`, `operationKey` and `title`;
- `operationHash`, `manifestHash` and `policyRevision`;
- `effect`;
- `customerId`;
- the normalized `input`.
- business/case identity, ownership version, connection revision, expiry and tags used by permission resolution.

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

**Operations and recovery.** The operator API and UI manage policy, review, activation and draining. Changed policy/catalog/connection and ownership invalidate unexecuted proposals; expired snapshots are terminal and cannot execute. External outcomes, audit and completion messages are recorded durably with action-level deduplication. `unknown` remains locked; the authenticated reconciliation endpoint records an operator-verified result and reason. Automatic reconciliation polling is not provided. Upstream mapping is explicit deployment configuration, not model input. The operator bearer is deployment-wide; per-business staff ACLs and SSO are not implemented.

The support worker's serialized relay sweeps expiry and interrupted executions on a ten-second cadence before opening its Redis producer. A sweep cannot overlap the next tick; database failures retry at the next cadence. Authenticated customer history refresh additionally expires only that customer's requested case, so inline/demo deployments do not require an operator page visit to show expiry.
