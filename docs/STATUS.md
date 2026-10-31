# Status (update on every merge)

Branch: `integration/support-copilot` (= `codex/node-backend` + `main` + support foundation).

| Area | State | Evidence |
|---|---|---|
| Harness core (context, tools, policy, sentiment, approval, execution, audit) | ✅ working (rules model) | `apps/api` `npm test` → 33/33 pass, lint + typecheck clean |
| HTTP routes (customer + operator) | ✅ working, in-memory store | API boots without Postgres/Redis; golden path via curl |
| LLM path (AI SDK: OpenAI / Gemini / Anthropic) | ⏳ code ready, **not verified** — no keys on the integration machine | run `npx tsx scripts/llm-spike.ts` (WS4) |
| Postgres store + migration | ⏳ WS3 | – |
| Frontend chat + console | ⏳ WS2 (current UI = starter health page) | – |
| E2E smoke script | ⏳ WS3 | – |
| Oracle deploy (ARM64) | ⏳ WS3 | – |
| Video + slides | ⏳ WS1, script in `docs/DEMO_SCRIPT.md` | – |

## Open decisions (team)
- License (proposal: MIT) — approve before making the repo public.
- Primary LLM provider/model — decided by WS4 spike.
