# Architecture

```
 Customer chat (/chat)            Operator console (/operator)
        │ X-Customer-Session               │ Bearer OPERATOR_TOKEN
        ▼                                  ▼
 ┌──────────────────────── Fastify API (apps/api) ────────────────────────┐
 │ support/routes.ts                                                       │
 │        │                                                                │
 │ agent/harness.ts  runTurn ─────────────────────────────┐   approve/reject
 │   1 controlled context (session customer, payments,     │        │
 │     policy, last 10 messages) — never ids from text     │        ▼
 │   2 model.decide  ──► AiSdkModel (OpenAI│Gemini│Claude)  │  claimProposal (atomic, argsHash)
 │        ≤4 steps, timeout; tools: lookup_payments (read)  │        │
 │        + submit_decision (typed, no execute)             │  re-check policy
 │        fails → RulesModel fallback (labelled)            │        │
 │   3 sentiment.ts  lexical signals ⊕ model label          │  payment-provider (SIMULATED)
 │        → priority / tone / escalation (never authorises) │        │
 │   4 policy.ts  deterministic checks per tool             │  recordRefund (UNIQUE payment)
 │   5 proposal: denied │ pending (high risk) │ auto (low)  │        │
 │   6 grounded reply (templates; success only after state) │  case resolved + audit + reply
 └──────────────── support/store.ts (SupportStore) ─────────┴────────────────┘
                 Memory (tests, zero-infra demo) │ Postgres (WS3)
```

## Agent harness guarantees
| Requirement | Where |
|---|---|
| Controlled context | `harness.ts` builds `AgentContext` from the session customer; the model never receives other customers' data |
| Explicit tool registry, typed args | `tools.ts` (zod); `lookup_payments` read-only and scoped; write tools have no `execute` in the model loop |
| Restrict tools per business | `business.policy.enabledTools` → only those are offered and allowed by policy |
| Policy validation | `policy.ts` — ownership, captured, not refunded, no open proposal, full amount, limit, duplicate twin |
| Human-in-the-loop | `refund_payment` is `risk: high` → always `pending` until an operator approves |
| Approval bound to exact operation | `argsHash = sha256(caseId, tool, canonical args)`; approve requires it |
| No duplicate execution | atomic `claimProposal` (pending → executing) + UNIQUE refund per payment/proposal + provider idempotency key |
| Re-validation at execution time | `execute()` re-runs policy against current state |
| Honest results | provider failure → proposal `failed`, reply says no refund was made; model replies claiming success are replaced |
| Run limits | ≤4 model steps, `LLM_TIMEOUT_MS`, one run per message, body ≤2000 chars |
| Failure handling | model error/timeout/invalid output → `RulesModel` fallback, `agent_runs.status=fallback` + audit |
| Audit | every step → `audit_events`; every model call → `agent_runs` |
| Deterministic tests | `ScriptedModel` + `MemorySupportStore` + `SimulatedPaymentProvider.failing` |

## Data model (`migrations/0002_support.sql`, WS3)
`businesses(id, slug, name, currency, policy jsonb)` · `customers(id, business_id, name, email, plan, session_token)` · `payments(id, customer_id, amount_cents, currency, merchant_ref, description, status, created_at)` · `cases(id, business_id, customer_id, status, priority, intent, analysis jsonb, created_at, updated_at)` · `messages(id, case_id, role, body, created_at)` · `action_proposals(id, case_id, tool, args jsonb, args_hash, risk, status, policy jsonb, decided_by, decided_at, result jsonb, error, created_at)` · `refunds(id, payment_id UNIQUE, proposal_id UNIQUE, amount_cents, provider_ref, created_at)` · `audit_events(id, case_id, type, actor, data jsonb, created_at)` · `agent_runs(id, case_id, provider, model, status, steps, tool_calls jsonb, latency_ms, error, created_at)`.

## Multi-business
Each business has its own policy (refund limit, duplicate window, enabled tools). New integrations = new tools in the registry + a policy branch + an executor branch; the harness, approvals and audit are reused.

## Deliberate simplifications (MVP)
- Customer identity = demo session tokens; operator auth = one shared bearer token. Roadmap: real auth/SSO, per-operator roles.
- Payment provider is simulated (`SIM-RF-*` refs). No real money moves.
- Synchronous agent run inside the request (2–10 s); no queue/streaming. BullMQ starter module is unused.
