# CLAUDE.md — Support Copilot (hackathon, deadline 17:00 Kyiv)

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
- `contracts.ts`, `store.ts` (interface), `docs/API_CONTRACTS.md`, `compose*.yaml`, `.github/**` belong to WS1. Need a change? Ask the integration owner; do not redesign them on your branch.
- The LLM never writes to the database. It proposes; `policy.ts` validates; a human approves high-risk actions; `harness.ts` executes.
- Identity = `X-Customer-Session` header → server-side customer. Never trust ids from message text.
- Sentiment may change priority, tone, escalation. It must never authorise money movement.
- Never claim success unless the backend recorded the state change. Refunds are simulated — say so.
- No shell/filesystem tools for the agent. No new infra (Redis/queues/vector DB) for the MVP.
- Secrets only in root `.env` (git-ignored). Never `PUBLIC_*`/`VITE_*` for secrets.
- Lint is `--max-warnings 0`; frontend TS is strict (`erasableSyntaxOnly`: no enums/parameter properties; `import type`).
- Work on your `feat/ws*` branch; WS1 merges into `integration/support-copilot` only when checks are green.
