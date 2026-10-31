# API contracts (frozen — changes only through WS1)

Source of truth for types: `apps/api/src/modules/support/contracts.ts`. Frontend mirror: `apps/frontend/src/lib/api.ts`.
Errors are `{ "detail": string | ValidationIssue[] }` (validation → 422), except approve 502 which returns `{proposal, case}`. Call the API same-origin only (`/api/...` via the Vite/Caddy proxy): CORS does not allow `X-Customer-Session`.

## Customer channel — header `X-Customer-Session: <token>`
Identity comes only from this header (demo personas `demo-olena`, `demo-taras`, `demo-ivan`, `demo-marta`). Never from message text.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/chat/personas` (demo only) | – | `[{name, plan, sessionToken, businessName}]` |
| POST | `/api/v1/chat/cases` | – | 201 `{id, status}`; 401 unknown session |
| GET | `/api/v1/chat/cases/:id` | – | `{id, status, businessName, messages: Message[]}`; 404 if not this customer's case |
| POST | `/api/v1/chat/cases/:id/messages` | `{body: string(1..2000)}` | `{caseId, status, reply: Message}` |

The customer never receives analysis, proposals or policy internals. A message triggers one bounded agent run (≤4 model steps, `LLM_TIMEOUT_MS`), may take several seconds.

## Operator console — header `Authorization: Bearer <OPERATOR_TOKEN>`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/cases?status=open\|awaiting_approval\|escalated\|resolved` | – | `SupportCase[]` sorted by priority, then recency |
| GET | `/api/v1/cases/:id` | – | `CaseDetail` = `{case, customer, payments, messages, proposals, audit, runs, refunds}` |
| POST | `/api/v1/proposals/:id/approve` | `{operator, argsHash}` | 200 `{proposal, case}` executed; **502 `{proposal, case}` (not `{detail}`)** when execution failed — provider error or policy re-check, `proposal.status="failed"`, reason in `proposal.error`; **409 `{detail}`** already decided or `argsHash` mismatch; 404 |
| POST | `/api/v1/proposals/:id/reject` | `{operator, reason}` | 200 `{proposal, case}`; 409 already decided |
| GET | `/api/v1/metrics` | – | `Metrics` (all values measured from stored state) |
| POST | `/api/v1/demo/reset` (demo only) | – | `{status:"reset"}` — re-seeds synthetic data |

`argsHash` must be copied from the proposal the operator is looking at; it binds the approval to that exact operation.

## Key types (abridged)
- `SupportCase {id, businessId, customerId, customerName, status, priority: P1|P2|P3, intent, analysis: Analysis|null, createdAt, updatedAt}`
- `Analysis {intent, summary, reasoning, sentiment: Sentiment, priority, tone: neutral|empathetic|de-escalating, source: llm|fallback, model}`
- `Sentiment {label: calm|frustrated|angry|abusive, frustration 0..1, abusive, urgency: low|medium|high, escalationRisk 0..1, signals: string[]}`
- `Proposal {id, caseId, tool, args, argsHash, risk: low|high, status: pending|executing|executed|rejected|failed|denied, policy: {allowed, requiresApproval, checks: [{name, passed, detail}]}, decidedBy, decidedAt, result, error, createdAt}`
- `AgentRun {provider, model, status: ok|fallback|failed, steps, toolCalls, latencyMs, error}`
- `AuditEvent {type, actor, data, createdAt}` — types: `case.opened, message.received, agent.analyzed, agent.fallback, action.proposed, action.denied, action.approved, action.rejected, action.executed, action.failed`
- `Refund {paymentId, proposalId, amountCents, providerRef, simulated: true}`

## Tools (registry: `apps/api/src/modules/agent/tools.ts`)
| Tool | Kind | Risk | Gate |
|---|---|---|---|
| `lookup_payments {limit}` | read | low | scoped to session customer, runs inside the model loop |
| `refund_payment {payment_id, amount_cents}` | write | high | policy + human approval, executed by backend only |
| `escalate_to_human {reason}` | write | low | policy, auto-executed |
