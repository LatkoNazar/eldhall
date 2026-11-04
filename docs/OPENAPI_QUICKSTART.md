# Connect a business API through OpenAPI

The TypeScript API and worker enforce permissions and execute the durable support workflow. The Python sidecar translates reviewed tools to your existing business API. It does not need access to the support PostgreSQL or Redis. The reference Orders API uses synthetic data and enforces customer ownership and cancellation state atomically; it is a fixture, not a payment connector.

## 1. Import local artifacts

Use Python 3.12+, `uv` and the committed lockfile. Keep private business specifications and review overlays outside the public example directory.

```sh
uv sync --locked --project apps/mcp-openapi
uv run --locked --project apps/mcp-openapi support-mcp-import \
  examples/orders/openapi.json examples/orders/review.json \
  --out /etc/eldhall/orders/manifest.json \
  --normalized-spec /etc/eldhall/orders/normalized.openapi.json \
  --report /etc/eldhall/orders/review-report.json
```

Create the output directory first. The review overlay explicitly chooses effect, trusted scope placement, output fields, registered guard and idempotency mapping. Importing does not activate operations. Read the report: unsupported operations are unavailable, and an `unknown` effect cannot execute. Use `--previous` for a catalog diff. Remote refs and arbitrary spec URLs are unsupported; `servers` never selects the trusted upstream.

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

In the operator **Integrations** page choose the business and catalog. Inspect each exact operation definition before enabling it. Set `get_order_status` to `auto`; set the `Orders` group to `ask` and cancellation to `inherit`. Activate the catalog after the live verification succeeds. All these actions are also available through the [headless integration endpoints](API_CONTRACTS.md).

Every mutation sends the last read integration `version`; a concurrent change returns 409 and requires rereading. Permission edits apply from PostgreSQL without restarting API or worker and invalidate pending/approved snapshots. A group rule does not review new operations. An operation override takes precedence over group defaults; mandatory scope, ownership and business guards always apply.

`ask` returns a durable pending proposal and ends the turn. Approval records consent for the exact snapshot; separate execute admits the action and records its outcome. Explicit `auto` writes use the same guard and ledger. Built-in refunds still require human approval.

The service bearer is a deployment-wide operator principal. This release does not provide isolated multi-business staff accounts, SSO or RBAC.

## 5. Update, recover and roll back

For a catalog or connection change, disable/drain the integration first. Account for dispatched actions, import immutable new artifacts, then restart sidecar, API and worker with the same artifacts. Review changed definitions and activate with the new expected version. A policy-only change requires no restart. Rolling back images never restores old approvals or grants old permissions automatically.

A PostgreSQL claim is not a distributed transaction with a remote API. Writes may commit after a timeout, cancellation or takeover. `unknown` remains locked against blind retry; an operator must verify the provider result and use reconciliation, with a reason and optional provider reference. Upstream must enforce ownership and state atomically even when a registered adapter performs a preflight read. Provider idempotency uses the durable action identity, not an arguments hash.

Release bundles include the sidecar image, standalone Compose overlays, Orders artifacts, scripts and permanent documentation. After loading the image archive, add `--env-file support-images.env` after your private environment file and use `up --no-build`. Deployment-owned private config/spec/secrets remain explicit external mounts. The bundled root-stack deploy script does not automatically enable the optional support/MCP composition.

## Verification

Run API lint, typecheck, build and tests, Python unittest discovery, real PostgreSQL integration tests and `npm --prefix apps/api run test:mcp-openapi`. The CI `sidecar-compose` job builds the standalone support composition with a synthetic upstream and scripted model. It covers disabled import, review, live schema validation, policy CAS, scoped reads, `ask` approval and execution, `auto` cancellation, guard/deny and draining. It uses no real customer data or paid model calls. Platform support is reported from actual build/runtime evidence; one platform's passing test does not establish another's support.
