# API contracts

Source of truth for types: `apps/api/src/modules/support/contracts.ts`. Frontend mirror: `apps/frontend/src/lib/api.ts`.
Errors are `{ "detail": string | ValidationIssue[] }` (validation → 422), except execute 502 which returns `{proposal, case}`. The bundled UI uses the same-origin Vite/Caddy proxy. Independent clients need an explicit `CORS_ORIGINS` entry; preflights permit GET/POST/PATCH and `Authorization`, `Content-Type`, `X-Customer-Session`, without credential cookies.

## Customer channel — header `X-Customer-Session: <token>`
Identity comes only from this header (demo personas `demo-olena`, `demo-taras`, `demo-ivan`, `demo-marta`). Never from message text.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/chat/personas` (demo only) | – | `[{name, plan, sessionToken, businessName}]` |
| POST | `/api/v1/chat/cases` | – | 201 `{id, status}`; 401 unknown session |
| GET | `/api/v1/chat/cases/:id` | – | `{id, status, ownership, businessName, messages: Message[],activeRun:{id,status}|null}`; 404 if not this customer's case |
| POST | `/api/v1/chat/cases/:id/messages` | `{body: string(1..2000),clientMessageId?:uuid}` | Worker: 202 `{caseId,status,ownership,reply:null,runId}`. Explicit inline: 200 with `reply:Message|null`. 409 for a different message while a run is active |

The customer never receives analysis, proposals or policy internals. Bot-owned conversations allow one bounded run at a time. Worker mode commits the customer message and durable outbox row atomically; it never runs DSH in the API process. Poll the case history for completion. A repeated `clientMessageId` with identical content returns the original run; changed content is rejected. Staff-owned messages are recorded and routed to staff without a model call (`reply:null`). Whitespace-only messages are rejected before storing. Ownership changes fence tools and final delivery from the old run.

The worker republishes pending PostgreSQL rows to BullMQ, so a broker outage or lost publish does not discard accepted input. Delivery is at least once; database leases/fences, logical proposal keys and atomic final-message/job completion prevent duplicate customer input, proposals and final output after redelivery. Leases renew every five seconds and expire after 30 seconds; recovery is limited to three claimed attempts. Recovered DSH attempts have isolated native checkpoints. Normal turns resume the stable conversation session and always receive current, bounded product history. Financial side effects remain separate approved executions with permanent payment reservations.

## Operator console — header `Authorization: Bearer <OPERATOR_TOKEN>`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/cases?status=open\|awaiting_approval\|escalated\|resolved` | – | `SupportCase[]` sorted by priority, then recency |
| GET | `/api/v1/cases/:id` | – | `CaseDetail` = `{case, customer, payments, messages, proposals, audit, runs, refunds}` |
| POST | `/api/v1/proposals/:id/approve` | `{argsHash}` | 200 `{proposal, case}`, proposal `approved`; no business action |
| POST | `/api/v1/proposals/:id/execute` | `{argsHash}` | 200 executed; 502 `{proposal,case}` failed/unknown; 409 absent/expired approval, different args, or reserved payment |
| POST | `/api/v1/proposals/:id/reject` | `{reason}` | 200 `{proposal, case}`; 409 already decided |
| POST | `/api/v1/cases/:id/takeover` | `{ownershipVersion?}` | `{case}` staff ownership; invalidates pending approvals |
| POST | `/api/v1/cases/:id/resume-bot` | `{ownershipVersion?}` | `{case}` explicit return to bot |
| POST | `/api/v1/cases/:id/resolve` | `{ownershipVersion?}` | `{case}` resolved, staff ownership |
| POST | `/api/v1/cases/:id/messages` | `{body,ownershipVersion?}` | `{message,case}`; requires current staff ownership |
| GET | `/api/v1/metrics` | – | `Metrics` (all values measured from stored state) |
| GET | `/api/v1/capabilities` | – | Actual configured runtime/provider/model/execution/persistence, credential-presence boolean, simulated payment provider |
| POST | `/api/v1/demo/reset` (demo only) | – | `{status:"reset"}` — re-seeds synthetic data |

`argsHash` must be copied from the proposal the operator is looking at; it binds the approval to that exact operation.
Approval expires after 15 minutes. The verified bearer maps to the deployment's `operator:staff` principal; a legacy `operator` body field is ignored. Payment-level reservations prevent separate proposals from dispatching a second refund. An ambiguous provider result becomes `unknown`, stays reserved, and requires manual reconciliation; retry never dispatches again. All refunds in this MVP are explicitly simulated.

## Headless administration

These endpoints use the same operator bearer. `?businessId=<uuid>` selects a configured business; omit it only when intentionally selecting the first business. Documents are shared with authenticated customers of that business after publication; per-document private ACLs are outside this version.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/v1/businesses` | `{businesses:[{id,slug,name,currency}]}` |
| POST | `/api/v1/businesses` | `{name,slug,currency,policy?}` → new business |
| POST | `/api/v1/customers` | `{businessId,name,email,plan}` → `{customer,sessionToken}`; opaque token generated by server |
| GET | `/api/v1/knowledge` | `{sources:KnowledgeSource[],capabilities}` |
| POST | `/api/v1/knowledge` | `{title,category,content,audience?,plans?}` → 201 draft |
| PATCH | `/api/v1/knowledge/:id` | `{title,category,content,version}` → new draft version; 409 stale |
| POST | `/api/v1/knowledge/:id/publish` or `/revoke` | `{version}` → new published/revoked version |
| GET | `/api/v1/knowledge/search?q=&k=&audience=customer\|any&plan=&businessId=` | `{query,mode:'hybrid'\|'lexical',embedder,tookMs,hits:[{id,title,version,audience,sourceUrl,section,content,score,passages}]}` — the agent's retrieval over published sources |
| GET | `/api/v1/knowledge/index` | `{embedder,vectorStore:'pgvector'\|'memory',chunks,staleChunks,documents,published,drafts,urlImport}` |
| POST | `/api/v1/knowledge/reindex` | re-embeds published sources with the current embedder → `{documents,chunks,embedder}` |
| GET | `/api/v1/knowledge/:id/versions` | `{versions:KnowledgeSource[]}` newest first |
| POST | `/api/v1/knowledge/import-url` | `{url,category,title?,audience?,plans?}` → 201 draft; 403 host not allow-listed, 422 invalid/private URL, 502 fetch failed |
| POST | `/api/v1/knowledge/upload` | `{filename,contentBase64,category,title?,audience?,plans?}` (.md/.txt/.html ≤ 512 KB) → 201 draft; 413/415 |
| GET | `/api/v1/skills` | `{skills:SupportSkill[],preset:"support-v1"}` |
| POST | `/api/v1/skills` | `{name:"custom/name",content,enabled?}` → versioned Markdown skill |
| GET | `/api/v1/settings` | `SupportSettings` |
| PATCH | `/api/v1/settings` | `{version,language,tone,requireApproval:true,refundLimitCents,duplicateWindowMinutes,enabledTools,classification?}` → new version; 409 stale; omitted classification is preserved |
| GET | `/api/v1/team` | Real bootstrap bearer principal and assigned-case count; invite/role changes disabled |

Knowledge retrieval is hybrid (BM25 over UA/EN terms + local hashing embeddings, fused with RRF) over heading-aware passages of published sources in the trusted business scope; a reply's `sourceRefs` list only the sources retrieved during that turn (see `docs/KNOWLEDGE_BASE.md`). Draft/revoked documents never enter new model context. Mid-run revocation or policy/skill changes fence final output. Skills cannot enable tools or turn off refund approval. Postgres persists messages, cases, proposals, runs, audit, documents, skills and settings; DSH owns its native session store separately.
Demo records are seeded only with `DEMO_RESET_ENABLED=true` (development default; production default false). Clean production setup creates a business and customers through the authenticated administration API; public demo session tokens are not provisioned automatically.
`SUPPORT_EXECUTION=worker` requires PostgreSQL and the worker process; it is the PostgreSQL default. `SUPPORT_EXECUTION=inline` is an explicit local demo option and the default for the memory store. Run the release migrations (`0002_support`, `0003_support_turns`, and `0004_classification`) before starting API or worker. PostgreSQL startup checks reject a missing support queue or classification schema.

### Configurable ticket classes

`SupportSettings.classification` is optional/null for businesses without classification, or `{revision,fallbackClassId,minimumConfidence,classes:[{id,label,description,examples}]}`. Configure it in the scoped `classifications` array of `SUPPORT_CONFIG_FILE`, or include it in a versioned settings PATCH. Class IDs are strings, including numeric-looking IDs such as `"1"`. See [the full configuration contract](integrations-runtime.md#business-ticket-classification) and [example](../examples/support.config.json).

The default support model decision returns optional `{classId,confidence,reason}`; an optional dedicated classifier supplies the same internal result independently. The backend checks it against the current business taxonomy and stores a snapshot in `Analysis.classification`: `{classId,label,confidence,reason,revision,needsReview,source,reasonCode,provider?,model?}`. Labels and revisions come from the server configuration. `confidence` is a finite score in 0–1: embedded models self-report it, while the dedicated Decisions adapter uses a returned choice probability. Neither is calibrated accuracy. Classifier `source` and optional `provider`/`model` are separate from conversation analysis provenance. `reason` is a short factual explanation.

`reasonCode` is `classified`, `low_confidence`, `unknown_class`, `missing_classification`, `invalid_classification`, or `model_fallback`. Low-confidence results select the configured fallback class; invalid, unknown, absent, or fallback-provider results do too and require review. Classification fallback has score0 rather than an invented category; a successful dedicated classifier may still label a turn whose conversation model fell back. The configured fallback class always requires review, even when the model selects it confidently.

Classifier updates need a higher taxonomy revision; stale settings versions conflict. The same revision/content is idempotent. Explicit `classification:null` disables classification and privately retains its last revision. It survives stale/equal-revision file bootstrap after restart; only a higher valid taxonomy revision re-enables it. Clients continue to see `classification:null`, not the internal disabled marker. Omitting the field preserves the current value for older clients. Existing case snapshots are not automatically rewritten, and an in-flight turn cannot commit analysis produced against a changed taxonomy. Custom classes do not replace safety-related `intent` or grant permissions to execute actions.

Optional `scoreKind` is `model_self_report` or `selected_probability`. A low-confidence known candidate also gets server-owned `proposedClassId`/`proposedLabel`; `confidence` remains the score of that proposed candidate while the final `classId` becomes the fallback. It must not be presented as the fallback class's probability.

## Key types (abridged)
- `SupportCase {id, businessId, customerId, customerName, status, priority: P1|P2|P3, intent, analysis: Analysis|null, ownership:bot|staff, ownershipVersion, assignedTo, createdAt, updatedAt}`
- `Analysis {intent, summary, reasoning, sentiment: Sentiment, priority, tone: neutral|empathetic|de-escalating, source: llm|fallback, model, classification?: TicketClassification|null}`
- `Sentiment {label: calm|frustrated|angry|abusive, frustration 0..1, abusive, urgency: low|medium|high, escalationRisk 0..1, signals: string[]}`
- `Proposal {id, caseId, tool, args, argsHash, risk: low|high, status: pending|approved|executing|executed|rejected|failed|denied|unknown, policy: {allowed, requiresApproval, checks: [{name, passed, detail}]}, decidedBy, decidedAt, result, error, createdAt}`
- `AgentRun {provider, model, status: ok|fallback|failed, steps, toolCalls, latencyMs, error}`
- `AuditEvent {type, actor, data, createdAt}` — types: `case.opened, message.received, agent.analyzed, agent.fallback, action.proposed, action.denied, action.approved, action.rejected, action.executed, action.failed`
- `Refund {paymentId, proposalId, amountCents, providerRef, simulated: true}`

## Tools (registry: `apps/api/src/modules/agent/tools.ts`)
| Tool | Kind | Risk | Gate |
|---|---|---|---|
| `lookup_payments {limit}` | read | low | scoped to session customer, runs inside the model loop |
| `refund_payment {payment_id, amount_cents}` | write | high | policy + human approval, executed by backend only |
| `escalate_to_human {reason}` | write | low | policy, auto-executed |
