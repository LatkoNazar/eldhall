# Current repository and scenario discovery

Verified against the repository on 2026-10-30. Re-read these files on every invocation;
the real MVP may have grown beyond this starter screen.

## Sources of truth

- `README.md`: startup, proxy, environment and deployment distinctions.
- `apps/frontend/package.json`, `vite.config.ts`, `src/App.tsx`, `src/App.test.tsx`.
- `apps/frontend/src/lib/health.ts`: same-origin readiness request and accepted response.
- `apps/backend/src/app/modules/system/router.py`: public health routes.
- `apps/backend/src/app/modules/jobs/router.py`: token-protected backend-only jobs.
- Current feature routes, auth components and fixtures, if new features have been added.

## Current browser surface

React/Vite renders the Starter page at `/`; there is no frontend router or business CRUD yet.
The visible state card calls `GET /health/ready` and shows PostgreSQL, Redis and RabbitMQ.
It displays `Усе працює`, a degraded dependency state, or `Не вдалося підключитися`.
The actual refresh button is `Перевірити ще раз`, disabled as `Перевіряємо…` while loading.
For Playwright, prefer `getByRole('button', { name: 'Перевірити ще раз' })` and headings
read from the current source over fixed pixel coordinates.

A truthful fallback demo opens this page, explains the visible readiness result, clicks
refresh, and shows the real response. Do not force a minimum film length with invented
features. A later real MVP journey should replace this infrastructure example.

Readiness is public and requires no demo account or token. HTTP503 with the valid
`unavailable` payload is a real degraded state; do not intercept it as success. If a demo
needs a healthy stack, start/fix the local dependencies instead of mocking green indicators.
UI tests mock responses for unit tests; those mocks are not a product recording scenario.

`POST /api/v1/jobs` and `GET /api/v1/jobs/{id}` require backend Bearer authentication and
have no browser controls today. Do not invent a submission page or put `API_TOKEN` in
frontend code, a URL, visible DevTools, a recorded terminal or public demo assets.

## Local startup when a recording is requested

Do not run startup merely to create or revise this skill. Reuse a healthy existing local
stack when available; verify its origin and current branch first.

Docker Compose requires v2.24+ according to the README. From the repository root, for a
fresh local setup only, copy `.env.example` if `.env` does not already exist. Preserve the
existing project name and credentials; do not regenerate an established environment.

```powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
docker compose -f compose.yaml -f compose.dev.yaml build
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres redis rabbitmq
docker compose -f compose.yaml -f compose.dev.yaml run --rm migrate
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait api worker frontend
```

Defaults: frontend `http://localhost:5173/`; API `http://localhost:8000/`; development
Swagger `/docs`. Respect existing `FRONTEND_LOCAL_PORT` / `API_LOCAL_PORT` overrides.
Do not print the whole `.env` to discover ports. Vite uses strict port5173 and will fail
instead of quietly choosing another one; verify the actual origin after launch.

For a frontend process outside Docker, use Node24.x (currently minimum24.15), keep backend
services running but omit the frontend container, then run from `apps/frontend`:

```powershell
npm ci
npm run dev
```

Vite proxies `/api/*` and `/health/*` to `http://127.0.0.1:8000`; `API_PROXY_TARGET` may
override it for a different local backend. Compose sets the target to `http://api:8000`.
Inspect `GET /health/ready` through the frontend origin as well as the rendered UI so the
recording proves the same proxy path the user uses. `/health/live` only proves process liveness.

## Data and scenario boundaries

There are no current UI accounts or business demo fixtures to pre-seed. For later features,
inspect the implemented auth and seed/test facilities. Use a dedicated local demo user and
non-sensitive data, set up outside the recorded interval. Never infer credentials or copy
a personal browser profile. Discover existing records before creating duplicates.

Demonstrate errors only when they serve the requested story. Browser-local simulated network
conditions must be disclosed as test conditions; do not stop shared services or change
production data merely to manufacture a failure shot. Keep labels and narration truthful.
