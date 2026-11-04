# CLAUDE.md — Support Copilot

Talk to the team in Ukrainian; code identifiers and technical terms in English.

## What this is
AI support copilot: customer chat → agent harness (intent, sentiment, tool calls) → deterministic policy → human approval → backend executes the action (simulated payment provider) → audit + grounded reply. Read `docs/ARCHITECTURE.md` and `docs/API_CONTRACTS.md` first.

## Layout
- `apps/api` — Fastify 5 + TypeScript (Node 24). Support code: `src/modules/support/*` (contracts, store, routes, seed, provider, factory), `src/modules/agent/*` (harness, model, ai-model, policy, sentiment, tools). Tests: `tests/*.test.ts` (node:test).
- `apps/frontend` — React 19 + Vite, plain CSS. Pages `/chat` and `/operator`.
- `apps/landing`, Umami, BullMQ jobs module — untouched starter parts; do not break them (CI builds them).

## Commands
```bash
cd apps/api && npm ci && npm test && npm run lint && npm run typecheck
cd apps/api && npm run dev     # :8000, in-memory store, no Docker; root .env sets OPERATOR_TOKEN
cd apps/frontend && npm ci && npm run dev                                 # :5173, proxies /api to :8000
cd apps/frontend && npm run lint && npm run typecheck && npm test && npm run build
cd apps/api && npx tsx scripts/llm-spike.ts                               # real LLM tool-call check (keys in root .env)
```
Local Node 25 prints EBADENGINE warnings; they are harmless. CI uses Node 24.

## Hard rules
- Shared contracts, migrations, Compose and CI changes have one coordinating owner and a separate reviewer. The historical hackathon WS1/WS2 ownership and integration branch workflow are retired; follow the current task's assigned file ownership.
- The LLM never writes to the database or calls business APIs directly. The backend validates current permissions and business guards. Built-in refunds require separate human approval and execution; reviewed external actions may use `ask` or explicitly configured `auto` through the durable execution ledger.
- Identity = `X-Customer-Session` header → server-side customer. Never trust ids from message text.
- Sentiment may change priority, tone, escalation. It must never authorise money movement.
- Never claim success unless the backend recorded the state change. Refunds are simulated — say so.
- No shell/filesystem tools for the agent. The support topology is API + worker, PostgreSQL + Redis, optional reviewed OpenAPI MCP sidecar and UI; preserve the scoped gateway.
- Secrets only in private deployment environment files or secret mounts; the local root `.env` is git-ignored. Never `PUBLIC_*`/`VITE_*` for secrets. Imported specifications and private fixtures stay outside public examples.
- Lint is `--max-warnings 0`; frontend TS is strict (`erasableSyntaxOnly`: no enums/parameter properties; `import type`).
- Use an isolated `codex/` branch for new work. Preserve existing user changes. Merge only after the required tests and independent review; document any unverified runtime/platform claims.
