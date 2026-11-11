# Connect a business API through OpenAPI

The TypeScript API and worker enforce permissions and execute the durable support workflow. The Python sidecar translates reviewed tools to your existing business API. It does not need access to the support PostgreSQL or Redis. The reference Orders API uses synthetic data and enforces customer ownership and cancellation state atomically; it is a fixture, not a payment connector.

## 1. Import local artifacts

### Connect from the operator interface

An optional managed adapter lets staff connect an API from **Integrations → Connect API** without editing the support configuration or restarting API/worker processes. Deploy it once with the private overlay.

```sh
docker compose --env-file /etc/eldhall/support.env \
  -f compose.yaml -f deploy/compose.managed-mcp.yaml up -d --build
```

Set `MANAGED_MCP_TOKEN` to a new private service credential of at least 24 random characters. API, worker and adapter share that credential; it is separate from the operator key and is never sent to the browser. Without this optional configuration the existing static connectors continue to work; URL onboarding reports unavailable. Run the normal migration chain first, including `0010_integration_imports.sql`.

Paste a **direct OpenAPI 3.0/3.1 JSON URL**, such as `https://api.example.com/openapi.json`, rather than a Swagger HTML page. The target defaults to that URL's origin and can be explicitly set to an API base path. OpenAPI `servers` does not silently select the target. Preview the operations, explicitly classify each supported operation as read or write, confirm trusted customer/business bindings and allowed output fields, and choose **Deny / Ask / Auto**. Every operation starts at Deny; HTTP methods and model confidence grant no access. Unsupported schemas stay visible and blocked. The same three choices remain available in compact operation rows after connection; existing inherited rules are available in advanced settings.

Confirm saves a disabled connection, installs the reviewed immutable manifest, verifies its exact identity, then activates it using a version check. A failed adapter check leaves the saved connection disabled and retryable. “Connected” verifies the adapter/catalog, not all upstream credentials or business permissions: the upstream still authorizes every real call. Ask creates a durable proposal and needs separate approval/execution; Auto remains subject to guards and trusted scope. Policy edits can invalidate pending actions.

Prepared snapshots expire after 30 minutes and persist in PostgreSQL with the connection, permissions and audit. The adapter cache is disposable: API and worker re-install the exact saved definition after an adapter restart. No database credential is passed to the adapter. New URL connections currently send the authenticated support customer/business UUIDs; an upstream using different identities needs the existing deployment-owned static `customerIdMap`/`upstreamBusinessId` configuration rather than IDs supplied by a customer or model.

Public HTTPS APIs can use the `none` credential profile. Protected APIs use deployment-owned Bearer profiles; arbitrary API-key headers, OAuth flows and OpenAPI `securitySchemes` are not automatically converted into credentials. For example, configure only the adapter:

```dotenv
MANAGED_UPSTREAM_PROFILES={"orders":{"name":"Orders API","principalId":"orders-service","origins":["https://api.example.com"],"upstreamBaseUrl":"https://api.example.com/v1","tokenEnv":"ORDERS_API_TOKEN"}}
ORDERS_API_TOKEN=YOUR_PRIVATE_UPSTREAM_CREDENTIAL
```

Pass that environment file only to `mcp-managed` using an additional private Compose override. Profiles expose names and configuration status, never secret values. A fixed `upstreamBaseUrl` cannot be overridden in the UI. The profile Bearer credential is sent to the spec URL only when its origin matches the selected upstream; protected cross-origin specifications need a local/static import in this first version. Credential rotation for the same upstream principal preserves the target fingerprint; changing that identity requires a new reviewed connection.

Private HTTP endpoints require an exact deployment-owned literal-IP exception: add the same origin to `origins` and `privateOrigins`, for example `http://127.0.0.1:8101` for a native local lab. Container loopback refers to the container itself. Ordinary URL input cannot enable private-network access. Requests reject redirects, compressed responses, remote/cyclic references and oversized documents; DNS resolution is validated and socket addresses are pinned for every upstream call. Metadata/link-local and multicast destinations remain blocked even with a private exception.

#### Connect through HTTP

Use the operator bearer and include `?businessId={businessId}` on every import request. Check `GET /api/v1/integration-imports/capabilities?businessId={businessId}` for the available credential profiles before preparing an import.

```http
POST /api/v1/integration-imports/prepare?businessId={businessId}
Authorization: Bearer <operator-token>
Content-Type: application/json

{
  "integrationId": "orders",
  "specUrl": "https://api.example.com/openapi.json",
  "credentialProfileId": "orders"
}
```

You can add `upstreamBaseUrl` when the credential profile permits an explicit target. Prepare returns a draft with `id`, `version`, `specHash`, `expiresAt` and candidate operations. It leaves the integration inactive. Read the draft again with `GET /api/v1/integration-imports/{id}?businessId={businessId}`.

Review each enabled operation against your API's actual authorization and response schema. The example below uses the shape of the repository's [Orders fixture](../examples/orders/openapi.json). Substitute the draft's actual `version` and `specHash`, and use the exact operation key and verified fields for your backend.

```http
POST /api/v1/integration-imports/{id}/confirm?businessId={businessId}
Authorization: Bearer <operator-token>
Content-Type: application/json

{
  "version": 1,
  "specHash": "<specHash from prepare>",
  "operations": [
    {
      "operationKey": "GET /orders/{order_id}",
      "mode": "auto",
      "review": {
        "effect": "read",
        "scope": {"customerId": {"in": "header", "name": "X-Customer-Id"}},
        "outputFields": ["order_id", "status"]
      }
    }
  ]
}
```

Omitted operations stay denied. The response contains `integration`, `policy`, `runtime` and `activation`. Confirm success by checking `runtime:"ready"` and `activation:"active"` before offering the tool to staff. If the response shows a saved disabled connection because the runtime is unavailable, restore the adapter and replay the same reviewed confirmation. Read back the effective permission at `GET /api/v1/integrations/{integrationId}/operations?businessId={businessId}`.

The lower-level static artifact workflow follows. Its CLI accepts local files. The managed service handles the URL workflow above.

Use Python 3.12+, `uv` and the committed lockfile. Keep private business specifications and review overlays outside the public example directory.

```sh
uv sync --locked --project apps/mcp-openapi
uv run --locked --project apps/mcp-openapi support-mcp-import \
  examples/orders/openapi.json examples/orders/review.json \
  --out /etc/eldhall/orders/manifest.json \
  --normalized-spec /etc/eldhall/orders/normalized.openapi.json \
  --report /etc/eldhall/orders/review-report.json
```

Create the output directory first. The review overlay explicitly chooses effect, trusted scope placement, output fields, registered guard and idempotency mapping. Importing does not activate operations. Read the report: unsupported operations are unavailable, and an `unknown` effect cannot execute. Use `--previous` for a catalog diff. The CLI does not fetch spec URLs and remote refs are unsupported; `servers` never selects the trusted upstream.

The [manifest contract](integrations-manifest.md) defines the supported schema subset, fingerprints and bounds. `FastMCP.from_openapi()` mechanically compiles the reviewed candidate inventory without network I/O; runtime tools are bounded wrappers of that inventory rather than an unrestricted mirror of the spec.

## 2. Provision a business and generate configuration

Start the ordinary support API with PostgreSQL, Redis and migrations. Provision your business through the [operator bootstrap](implementation.md#headless-bootstrap), or include an initial business entry in the deployment configuration. Use the returned business UUID:

```sh
npm --prefix apps/api ci
npm --prefix apps/api run build
node scripts/openapi-config.mjs \
  --manifest /etc/eldhall/orders/manifest.json \
  --business-id YOUR_BUSINESS_UUID \
  --url http://mcp-openapi:8000/mcp \
  --upstream-url https://your-business-api.example \
  --upstream-principal orders-service \
  --credential-env MCP_SERVICE_TOKEN \
  --out /etc/eldhall/support.json
```

The generator uses the backend's runtime validator, refuses to overwrite an existing file, and starts every operation disabled with default `deny`. Merge `catalogs` into an existing reviewed support config if you already have one. Keep the same manifest in the sidecar mount and support config. `connectionRevision` is a positive decimal string; increase it when changing target, credential principal reference or trusted identity mapping. Rotation of the token for the same principal does not change the revision.

By default upstream receives support business/customer IDs. If your host system uses different IDs, set the catalog's deployment-owned `upstreamBusinessId` and `customerIdMap`. A configured map denies missing entries. These values come from authenticated support identities, never customer messages or model arguments.

## 3. Start the sidecar

In a private environment file configure `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `API_TOKEN`, `OPERATOR_TOKEN`, model credentials and:

```dotenv
SUPPORT_CONFIG_PATH=/etc/eldhall/support.json
MCP_MANIFEST_PATH=/etc/eldhall/orders/manifest.json
MCP_UPSTREAM_BASE_URL=https://your-business-api.example
MCP_SERVICE_TOKEN=YOUR_SEPARATE_SERVICE_SECRET
MCP_UPSTREAM_TOKEN=YOUR_BUSINESS_API_SECRET
MCP_UPSTREAM_PRINCIPAL_ID=orders-service
MCP_CONNECTION_REVISION=1
```

Use generated private secrets, not these placeholders. The reviewed config binds the actual upstream URL and a nonsecret principal label through `upstreamTargetFingerprint`; the sidecar reports both that fingerprint and `connectionRevision`. A target or label mismatch refuses activation and calls, even with the same manifest. Keep the principal label aligned with the credential's actual upstream account; the sidecar does not introspect opaque tokens. Rotation for the same principal leaves the fingerprint unchanged. The upstream token stays in Python; API and worker receive only the service token. The sidecar publishes no host port. The overlay allowlists exactly `http://mcp-openapi:8000` for the trusted private service network; external MCP still requires HTTPS.

```sh
docker compose --env-file /etc/eldhall/support.env \
  -f deploy/support.compose.yaml \
  -f deploy/support.config.compose.yaml \
  -f deploy/support.mcp.compose.yaml up -d --build --wait
```

For existing PostgreSQL, replace the first Compose file with `deploy/support.external-db.compose.yaml` and set `DATABASE_URL`. This recipe still runs Redis. Add `--profile ui` before `up` if using the optional dashboard. Health verifies the processes; activation separately verifies the live manifest and exact tool schemas.

## 4. Review, set rules and activate

In the operator **Integrations** page choose the business and catalog. Inspect each exact operation definition, select Auto for `get_order_status` and Ask for cancellation, then save. Activate the catalog after the live verification succeeds. Advanced inherited rules apply only after an exact definition has been explicitly granted; they never enable a new operation. All these actions are also available through the [headless integration endpoints](API_CONTRACTS.md).

Every mutation sends the last read integration `version`; a concurrent change returns 409 and requires rereading. Selecting Ask or Auto for an exact operation and saving its loaded manifest/operation hashes atomically grants that definition; no separate per-operation review or enable action is needed. New or changed operations remain Deny, and selecting Deny revokes their grant; default/group edits never grant unseen definitions. Permission edits apply from PostgreSQL without restarting API or worker and invalidate pending/approved snapshots. An operation override takes precedence over group defaults; mandatory scope, ownership and business guards always apply.

`ask` returns a durable pending proposal and ends the turn. Approval records consent for the exact snapshot; separate execute admits the action and records its outcome. Explicit `auto` writes use the same guard and ledger. Built-in refunds still require human approval.

The service bearer is a deployment-wide operator principal. This release does not provide isolated multi-business staff accounts, SSO or RBAC.

## 5. Update, recover and roll back

For a catalog or connection change, disable/drain the integration first. Account for dispatched actions, import immutable new artifacts, then restart sidecar, API and worker with the same artifacts. Review changed definitions and activate with the new expected version. A policy-only change requires no restart. Rolling back images never restores old approvals or grants old permissions automatically.

A PostgreSQL claim is not a distributed transaction with a remote API. Writes may commit after a timeout, cancellation or takeover. `unknown` remains locked against blind retry; an operator must verify the provider result and use reconciliation, with a reason and optional provider reference. Upstream must enforce ownership and state atomically even when a registered adapter performs a preflight read. Provider idempotency uses the durable action identity, not an arguments hash.

The worker sweeps expiry/recovery approximately every ten seconds, independently of operator UI visits and before Redis publishing. Inline/demo customer history reads also refresh expiry for the authenticated customer's own case. An unresolved unknown action blocks another write in that case even after an operator returns it to the bot.

Release bundles include the sidecar image, standalone Compose overlays, Orders artifacts, scripts and permanent documentation. After loading the image archive, add `--env-file support-images.env` after your private environment file and use `up --no-build`. Deployment-owned private config/spec/secrets remain explicit external mounts. The bundled root-stack deploy script does not automatically enable the optional support/MCP composition.

## Verification

From `apps/mcp-openapi`, run the pinned correctness lint rules (`E9`, `F63`, `F7`, `F82`) and Python tests:

```sh
uv run --locked ruff check src tests
uv run --locked python -m unittest discover -s tests -v
```

Run API lint, typecheck, build and tests, real PostgreSQL integration tests and `npm --prefix apps/api run test:mcp-openapi`. The CI `sidecar-compose` job builds the standalone support composition with a synthetic upstream and scripted model. It covers disabled import, review, live schema validation, policy CAS, scoped reads, `ask` approval and execution, `auto` cancellation, guard/deny and draining. It uses no real customer data or paid model calls. Platform support is reported from actual build/runtime evidence; one platform's passing test does not establish another's support.
