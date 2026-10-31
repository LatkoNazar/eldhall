# PRD — Support Copilot (MVP)

**Problem.** Support teams spend most time on repetitive, policy-driven money questions (duplicate charges, refunds) while angry customers wait. Chatbots answer but cannot act safely; agents act but must dig through billing tools by hand.

**Product.** An AI copilot that understands the customer's goal and mood, checks real account data and business policy, proposes a concrete action, lets a human approve it in one click, executes it through a backend tool and keeps a full audit trail. Works for different businesses through per-business policies and a tool registry.

**Golden scenario.** Olena (NovaPay Fitness, Premium) was charged 499.00 UAH twice for October 40 s apart. She writes angrily. The AI finds both charges via `lookup_payments`, classifies `duplicate_charge`, frustrated/high urgency → P1, proposes `refund_payment` for the later charge. Policy passes; refund needs approval. Operator sees analysis, signals, policy checklist → Approve. Backend refunds via the simulated provider, marks payment refunded, resolves the case, tells Olena with the reference. A second Approve is refused.

## Features, acceptance criteria, owners
| Feature | Acceptance criteria | Owner | Tests |
|---|---|---|---|
| Agent harness | one bounded run per message; typed decision; fallback on failure; run + audit recorded | WS4 (core by WS1) | support.test 1, 8 |
| Refund action | executes only after approval with matching argsHash; exactly one refund per payment; payment + case updated | WS1/WS3 | 1, 5, 7 |
| Policy | denies foreign payment, non-duplicate, over-limit, already refunded; sentiment not an input | WS4 | 4, 7 |
| Approvals | approve/reject by operator; rejected → no refund, customer told; 409 on repeat | WS1 | 6, 7 |
| Honesty | provider failure → `failed`, no refund row, honest reply; success claims without state replaced | WS4 | 9, guard test |
| Sentiment & escalation | abusive → P1 + escalation; frustrated ≠ abusive; signals shown in UI | WS4 | 10 |
| Unsupported / missing info | cancellation → escalation; no duplicate → clarifying question | WS4 | 2, 3 |
| Customer chat | responsive (mobile-first chat; desktop centred), persona picker, live updates | WS2 | frontend RTL + 375/768/1440 check |
| Operator console | queue by priority, analysis, policy checklist, approve/reject, audit, metrics | WS2 | frontend RTL |
| Persistence | Postgres store, atomic claim, UNIQUE refunds, reset | WS3 | postgres-store.test |
| E2E smoke + deploy | `support-smoke.mjs` passes locally and on the Oracle server | WS3 | smoke |

## Test plan (business-level)
1 supported action succeeds · 2 unsupported request · 3 missing information · 4 denied by policy · 5 approval required · 6 approval rejected · 7 duplicate/tampered approval · 8 LLM failure/timeout/invalid output · 9 tool/provider failure · 10 abusive vs frustrated. Fixtures: `seed.ts` (synthetic). E2E: `apps/api/scripts/support-smoke.mjs`. Eval: `apps/api/scripts/eval.ts` (measured accuracy for slides).

## Out of scope (roadmap)
Real payment provider integrations, SSO/RBAC, multi-channel (email, Telegram), knowledge-base RAG, streaming replies, analytics warehouse, auto-approval thresholds learned from operator decisions.
