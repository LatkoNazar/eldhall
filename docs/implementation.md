# Support MVP implementation

This is the current implementation guide. The architecture, business-model and integration proposals describe a broader direction; they are not release evidence. The active UI follows the [0.2 light design references](design-system.md): white sidebar, pink selection, crimson buttons with white text. Dashboard, customer chat and any independent widget are optional API clients.

## Runtime and storage

Node.js 24.15+ within 24.x runs two processes: Fastify API and BullMQ worker. PostgreSQL 17 stores product state; Redis 7 delivers background work. Run the explicit migrations before either process. The migration runner retains the starter jobs compatibility checks and applies `0002_support` and `0003_support_turns`.

DeepSeek Harness packages are pinned to `0.2.2-alpha.2`. DSH owns the model/tool loop and its native session files under `RUNTIME_HOME`; PostgreSQL owns messages, runs, proposals and audit. Configure `LLM_PROVIDER=google`, `LLM_MODEL=gemini-3.5-flash-lite`, `AGENT_RUNTIME=dsh` and server-only `GEMINI_API_KEY`. `GOOGLE_GENERATIVE_AI_API_KEY` remains a compatibility fallback. `LLM_PROVIDER=local` requires a configured compatible `LLM_BASE_URL`, model identifier and optional `LOCAL_MODEL_API_KEY`. Provider keys never belong in `PUBLIC_*` or `VITE_*` variables.

The dedicated support profile exposes scoped payment lookup, published-knowledge search and decision submission. Reviewed configured MCP read tools add a bounded business-tool facade. Model skills are prose, not executable plugins. The child receives a restricted environment and no business database credentials or model-facing shell/filesystem tools. A child process is not an operating-system security boundary.

With `SUPPORT_STORE=postgres`, `SUPPORT_EXECUTION=worker` is the default. HTTP message acceptance commits the customer message and PostgreSQL outbox atomically and returns 202 with `reply:null` and `runId`. The worker republishes pending rows to Redis, acquires a fenced lease and completes the final message with the durable job outcome. Poll the customer case for completion. One active run per case, bounded recovery and payment reservations guard redelivery; this is not a claim of exactly-once broker delivery. A repeated `clientMessageId` with the same text returns the original run. Staff takeover fences the old run; resuming the bot is explicit.

## Native start

Install API dependencies with `npm --prefix apps/api ci`. Copy `.env.example` only when no private `.env` exists. Make the configured database available, start PostgreSQL/Redis and set their native hostnames, ports and credentials in `.env`:

```dotenv
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
SUPPORT_STORE=postgres
SUPPORT_EXECUTION=worker
DEMO_RESET_ENABLED=false
AGENT_RUNTIME=dsh
LLM_PROVIDER=google
LLM_MODEL=gemini-3.5-flash-lite
LLM_TIMEOUT_MS=60000
RUNTIME_HOME=.runtime/dsh
```

Add your private `GEMINI_API_KEY` and operator bearer to that file. Set `API_TOKEN` for the preserved starter jobs API as well. Both processes read the repository `.env`; native relative runtime/config paths resolve from `apps/api` when using these commands. Keep the same absolute `RUNTIME_HOME` for repeated launches if you change working directories.

```powershell
# Repository root:
npm --prefix apps/api run build
npm --prefix apps/api run migrate
npm --prefix apps/api start
# Another terminal, repository root:
npm --prefix apps/api run worker
```

`GET http://localhost:8000/health/live` checks the API process. `/health/ready` checks PostgreSQL and Redis; it does not prove that a model or external MCP server is reachable. The worker heartbeat requires active processing connections and a successful PostgreSQL check; it does not establish successful outbox publication. Development exposes `/docs` and `/openapi.json`; production disables them.

The optional React app starts with `npm --prefix apps/frontend ci` then `npm --prefix apps/frontend run dev`. Open `/operator` on port 5173 with `OPERATOR_TOKEN`, or `/chat` with a provisioned customer session. Vite proxies `/api` to port 8000. The six screens use actual API data; Team exposes the current staff principal with invitations and role changes disabled.

An offline synthetic demo explicitly selects `LLM_PROVIDER=rules`, `AGENT_RUNTIME=rules` and `DEMO_RESET_ENABLED=true`. Use `SUPPORT_STORE=memory` with `SUPPORT_EXECUTION=inline` only when reset-on-restart storage is intended. PostgreSQL and Redis are still dependencies of the starter API/worker. The memory store is not a production persistence option.

<a id="headless-bootstrap"></a>
## Headless bootstrap

Production disables demo personas and reset. Create a business and customer with the operator bearer. This PowerShell 7 example keeps the returned session in variables rather than printing it:

```powershell
$base = 'http://localhost:8000'
$operatorToken = Read-Host 'OPERATOR_TOKEN from your private configuration' -MaskInput
$staff = @{ Authorization = "Bearer $operatorToken" }
$business = Invoke-RestMethod "$base/api/v1/businesses" -Method Post -Headers $staff -ContentType application/json -Body (@{
  name = 'Example Store'; slug = 'example-store'; currency = 'UAH'
} | ConvertTo-Json)
$customer = Invoke-RestMethod "$base/api/v1/customers" -Method Post -Headers $staff -ContentType application/json -Body (@{
  businessId = $business.id; name = 'Synthetic Test Customer'; email = 'customer@example.test'; plan = 'Test'
} | ConvertTo-Json)
$session = @{ 'X-Customer-Session' = $customer.sessionToken }
$case = Invoke-RestMethod "$base/api/v1/chat/cases" -Method Post -Headers $session
Invoke-RestMethod "$base/api/v1/chat/cases/$($case.id)/messages" -Method Post -Headers $session -ContentType application/json -Body (@{
  body = 'Please help me with a delivery question.'; clientMessageId = [guid]::NewGuid().ToString()
} | ConvertTo-Json)
Invoke-RestMethod "$base/api/v1/chat/cases/$($case.id)" -Headers $session
```

Customer sessions are opaque bearer credentials for the authenticated customer, not user-supplied identity claims. Deliver them only to the intended customer through your authenticated host application. This MVP does not implement host-app login, OAuth, session rotation or staff invitations. A new business has no payment history; the production bootstrap does not import or fabricate payments. Synthetic refund examples require the explicit local demo seed.

Use the [administration API](API_CONTRACTS.md#headless-administration) to create/publish knowledge, add reviewed `custom/...` skills and update versioned settings. Include `?businessId=<uuid>` when more than one business exists. Refund approval stays mandatory: `approve` records consent tied to `argsHash`, while `execute` separately rechecks policy and dispatches the simulated operation. An unknown provider result keeps the payment reserved for manual reconciliation.

## Configuration without rebuilding

Business-specific ticket classes are configured in the file's `classifications` array. Each entry names a business, revision, fallback class, model-confidence threshold and classes with stable IDs, labels, descriptions and examples. The default agent decision classifies each new turn; an optional dedicated classifier can supply classification independently while Gemini handles the support conversation. Low-confidence/invalid outputs fall back for operator review. The dashboard shows the persisted class snapshot and a read-only taxonomy summary in Settings. See [the classification guide](integrations-runtime.md#business-ticket-classification). Classification does not grant tool permissions or replace refund guards.

Set `SUPPORT_CONFIG_FILE` to reviewed JSON. [The complete guide](integrations-runtime.md) covers startup validation, versioned documents/skills, deterministic guards and scoped read-only MCP tools. [The example](../examples/support.config.json) includes an illustrative orders connector; replace its URL and provide the referenced `ORDERS_MCP_TOKEN`, or remove `integrations` for docs-only setup. No connector credential is required when no integrations are configured.

Configuration loads at startup. Restart both API and worker after changing the file or connector environment so the processes agree. Higher document versions and skill revisions update stored rows; equal revisions must match, and lower revisions do not replace newer edits. Existing business policy stays under persisted settings. Skill text and KB content cannot grant execution permissions. MCP output is projected to reviewed fields; the upstream server must enforce business/customer ownership and read-only access.

Independent browser clients can set an explicit list such as `CORS_ORIGINS='["https://support.example.com"]'`. Allowed preflights are GET/POST/PATCH and the documented authorization/content/customer-session headers. Credential cookies are disabled. CORS does not replace API authentication. The bundled UI uses a same-origin proxy and needs no cross-origin configuration.

<a id="self-host-compose"></a>
## Self-host Compose

`deploy/support.compose.yaml` is a separate headless stack: PostgreSQL, Redis, a one-shot migration, API and worker. It retains no dependency on the legacy landing or Umami services. Docker with a working Linux engine and Compose 2.24+ is required. Use a dedicated `PROJECT_NAME` before the first start to avoid sharing a Compose project with an existing installation.

Create a private `.env.support` containing `PROJECT_NAME`, the database/Redis credentials, `API_TOKEN`, `OPERATOR_TOKEN` and `GEMINI_API_KEY`. Use at least 16 characters for service passwords, 32 for `API_TOKEN`, 24 for `OPERATOR_TOKEN`, and keep the real file untracked. The stack sets production mode, persistent storage, DSH, queued execution and disables demo reset. Its default model is `gemini-3.5-flash-lite`; configure `LLM_PROVIDER`/`LLM_MODEL` for another supported provider. `AGENT_RUNTIME=rules` plus `LLM_PROVIDER=rules` is an explicit offline alternative.

```powershell
docker compose --env-file .env.support -f deploy/support.compose.yaml config --quiet
docker compose --env-file .env.support -f deploy/support.compose.yaml up -d --build --wait
# Optional dashboard and customer chat:
docker compose --env-file .env.support -f deploy/support.compose.yaml --profile ui up -d --build --wait
```

Migration completion gates API/worker start. API binds `127.0.0.1:18000` and the optional web client binds `127.0.0.1:18001`; override `SUPPORT_API_PORT`/`SUPPORT_WEB_PORT` as needed. Use an authenticated tunnel or your existing TLS reverse proxy for remote access. PostgreSQL and Redis have no published ports. Data lives in named PostgreSQL, Redis and runtime volumes; back up both product data and the DSH home. Avoid deleting volumes during upgrades.

To mount an operator-owned JSON file read-only, set `SUPPORT_CONFIG_PATH` in `.env.support` to its absolute path, or a path relative to `deploy/`, and add the config overlay:

```powershell
docker compose --env-file .env.support -f deploy/support.compose.yaml -f deploy/support.config.compose.yaml --profile ui config --quiet
docker compose --env-file .env.support -f deploy/support.compose.yaml -f deploy/support.config.compose.yaml --profile ui up -d --build --wait
```

The overlay sets `/config/support.json` for API/worker and optionally reads `../.env.connectors` (relative to `deploy/`). Override `SUPPORT_CONNECTOR_ENV_FILE` for another private file. Put the example connector's `ORDERS_MCP_TOKEN` there. The file is optional for configurations without credential references; configured missing credentials fail startup. Do not print a fully interpolated Compose configuration containing secrets; `config --quiet` validates without displaying values.

The original root Compose files, deployment scripts, landing and Umami remain available as starter infrastructure. They are separate from this support deployment recipe. Production Caddy serves the optional web build and proxies `/api` without exposing provider secrets.

## Verification and current limits

API checks: `npm --prefix apps/api run lint`, `run typecheck`, `test`, `run build`. `npm --prefix apps/api run test:runtime` runs the actual pinned DSH against a deterministic local compatible model server. It starts native processes and must be run where native checkpoint writes are permitted. `npm --prefix apps/api run test:postgres` uses a real PostgreSQL connection, an isolated temporary schema and `TEST_POSTGRES_HOST/PORT/DB/USER/PASSWORD`; it does not silently skip a missing database. The ordinary API suite also exercises real local MCP protocol connections. Live Gemini testing requires the private server key and is distinct from the deterministic runtime suite.

Frontend checks are `lint`, `typecheck`, `test`, `build`; install landing dependencies too because the frontend tests import the real landing module. CI also validates the standalone headless/UI/config Compose definitions, while preserving starter jobs and analytics checks.

Implemented financial operations use a **simulated payment provider**. Knowledge search is lexical, without embeddings/pgvector. MCP integration supports configured reads only. Authentication has one configured staff principal; SSO, invitations and RBAC remain future work. No OSI license has been selected, and no managed-cloud deployment is provisioned here. A successful Compose parse is not evidence of a Docker image build or container startup; report those checks separately from native validation.
