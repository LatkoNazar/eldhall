# PRD — Support Copilot (MVP)

**Problem.** Support teams spend most time on repetitive, policy-driven money questions (duplicate charges, refunds) while angry customers wait. Chatbots answer but cannot act safely; agents act but must dig through billing tools by hand.

**Product.** An AI copilot that understands the customer's goal and mood, checks scoped account data and business policy, proposes an action, records human approval for exact arguments, and executes only through a separate guarded backend request. It keeps an audit trail and supports business-owned policies, ticket classes, knowledge and read-only MCP integrations. Current implementation and measured evidence: [STATUS](STATUS.md), [architecture](ARCHITECTURE.md), [API](API_CONTRACTS.md).

**Golden scenario.** A synthetic customer reports a duplicate charge. The AI looks up that customer's payments and proposes a full refund of the later captured duplicate. Deterministic policy checks ownership, amount/currency, duplicate window and business limit. Approve records consent without a refund. Separate Execute rechecks current guards and reserves the payment before dispatching the simulated provider. The recorded outcome updates the payment/case and informs the customer. Repeated execution cannot create another refund; unknown outcomes require reconciliation. No real money moves.

## Features, acceptance criteria, owners
| Feature | Acceptance criteria | Owner | Tests |
|---|---|---|---|
| Agent harness | one bounded run per message; typed decision; fallback on failure; run + audit recorded | WS4 (core by WS1) | support.test 1, 8 |
| Refund action | executes only after approval with matching argsHash; exactly one refund per payment; payment + case updated | WS1/WS3 | 1, 5, 7 |
| Policy | denies foreign payment, non-duplicate, over-limit, already refunded; sentiment not an input | WS4 | 4, 7 |
| Approvals | approve/reject by operator; exact argsHash; approval and execution separate; rejected → no refund; duplicate execute refused | Integration owner | support-state.test, support.test |
| Honesty | provider failure → `failed`, no refund row, honest reply; success claims without state replaced | WS4 | 9, guard test |
| Sentiment & escalation | abusive → P1 + escalation; frustrated ≠ abusive; signals shown in UI | WS4 | 10 |
| Unsupported / missing info | cancellation → escalation; no duplicate → clarifying question | WS4 | 2, 3 |
| Customer chat | responsive (mobile-first chat; desktop centred), persona picker, live updates | WS2 | frontend RTL + 375/768/1440 check |
| Operator console | queue by priority, analysis, policy checklist, approve/reject, audit, metrics | WS2 | frontend RTL |
| Persistence | PostgreSQL, durable turn outbox, fenced worker leases, payment reservations and simulated refund uniqueness | Integration owner | postgres-store.integration.ts |
| Ticket taxonomy | Business-scoped versioned classes, low-score fallback/review, category never grants action permission | Integration owner | classification.test.ts, classification-config.test.ts |
| KB Insights | Worker analyses scoped dialogue samples, cites actual evidence and creates KB drafts only on operator request | Integration owner | insights.test.ts, insights.integration.ts, insights-runtime.test.ts |
| Self-host packaging | Headless API/worker and optional UI Compose; no Oracle deployment or container-runtime success assumed | Integration owner | Compose validation; exact runtime checks in STATUS |

## Test plan (business-level)
1 supported action succeeds · 2 unsupported request · 3 missing information · 4 denied by policy · 5 approval required · 6 approval rejected · 7 duplicate/tampered execution · 8 LLM failure/timeout/invalid output · 9 provider failure/unknown outcome · 10 abusive vs frustrated. Fixtures in `seed.ts` are synthetic. Maintained API, native runtime, PostgreSQL and frontend commands are in [implementation](implementation.md#verification-and-current-limits). Provider checks and test counts must be reported from actual evidence; no intent-accuracy benchmark or deployed smoke result is assumed.

## Out of scope (roadmap)
Real payment provider integrations, SSO/RBAC, multi-channel (email, Telegram), embedding/vector retrieval, streaming replies, analytics warehouse and learned auto-approval. Current knowledge retrieval is lexical, classification is configurable, and KB Insights remains a review-and-draft workflow.
