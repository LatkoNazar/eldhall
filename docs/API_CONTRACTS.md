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

An external operation in `ask` mode saves its pending proposal and ends the bounded model turn, for reads as well as writes. The application supplies the pending reply and blocks subsequent business tools, knowledge searches and builtin actions from that turn. Human approval happens later through the separate operator endpoints; no model or worker lease waits for a person. Native DSH termination uses a trusted application control field outside the business result. An upstream payload containing `status:"awaiting_approval"` cannot create approval state or end a turn.

The worker republishes pending PostgreSQL rows to BullMQ, so a broker outage or lost publish does not discard accepted input. Delivery is at least once; database leases/fences, logical proposal keys and atomic final-message/job completion prevent duplicate customer input, proposals and final output after redelivery. Leases renew every five seconds and expire after 30 seconds; recovery is limited to three claimed attempts. Recovered DSH attempts have isolated native checkpoints. Normal turns resume the stable conversation session and always receive current, bounded product history. Financial side effects remain separate approved executions with permanent payment reservations.

## Operator console — header `Authorization: Bearer <OPERATOR_TOKEN>`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/cases?status=open\|awaiting_approval\|escalated\|resolved` | – | `SupportCase[]` sorted by priority, then recency |
| GET | `/api/v1/cases/:id` | – | `CaseDetail` = `{case, customer, payments, messages, proposals, audit, runs, refunds, activeRun, requestCatalog}` |
| POST | `/api/v1/proposals/:id/approve` | `{argsHash}` | 200 `{proposal, case}`, proposal `approved`; no business action |
| POST | `/api/v1/proposals/:id/execute` | `{argsHash}` | 200 executed; 502 `{proposal,case}` failed/unknown; 409 absent/expired approval, different args, or reserved payment |
| POST | `/api/v1/proposals/:id/reject` | `{reason}` | 200 `{proposal, case}`; 409 already decided |
| POST | `/api/v1/cases/:id/takeover` | `{ownershipVersion?}` | `{case}` staff ownership; invalidates pending approvals |
| POST | `/api/v1/cases/:id/resume-bot` | `{ownershipVersion?}` | `{case}` explicit return to bot |
| POST | `/api/v1/cases/:id/resolve` | `{ownershipVersion?}` | `{case}` resolved, staff ownership; 409 without partial ownership changes if tracked requests or effects still require attention |
| POST | `/api/v1/cases/:id/messages` | `{body,ownershipVersion?}` | `{message,case}`; requires current staff ownership |
| POST | `/api/v1/cases/:id/requests/:requestId/transition` | `{version,revision,transition:fulfill\|cancel\|reopen,reason,proof:{proposalIds,messageIds}}` | `{requestCatalog}`; operator-only, same-case evidence and optimistic versions required; this endpoint never executes a business action |
| GET | `/api/v1/metrics` | – | `Metrics` (all values measured from stored state) |
| GET | `/api/v1/capabilities` | – | Actual configured runtime/provider/model/execution/persistence, credential-presence boolean, simulated payment provider |
| POST | `/api/v1/demo/reset` (demo only) | – | `{status:"reset"}` — re-seeds synthetic data |

`requestCatalog` tracks customer goals separately from proposals. It has a catalog
`version`, `syncState`, `lastSourceMessageId`, stable request records and bounded
`history:{events,hasMore}`. Requests reference the shared messages and specific
proposal revisions; selecting one does not create another conversation. A
proposal's execution does not automatically fulfill a goal, and completing one
action cannot resolve a tracked ticket with other open goals. Existing cases
without classified requests retain their historical actions. See the
[request catalog contract and safety boundaries](REQUEST_CATALOG.md).

`argsHash` must be copied from the proposal the operator is looking at; it binds the approval to that exact operation.
Approval expires after 15 minutes. The verified bearer maps to the deployment's `operator:staff` principal; a legacy `operator` body field is ignored. Payment-level reservations prevent separate proposals from dispatching a second refund. An ambiguous provider result becomes `unknown`, stays reserved, and requires manual reconciliation; retry never dispatches again. All refunds in this MVP are explicitly simulated.

## Headless administration

These endpoints use the same operator bearer. `?businessId=<uuid>` selects a configured business; omit it only when intentionally selecting the first business. Customer retrieval includes published documents in that business with customer audience and a matching plan, when restricted. Internal documents and other-plan documents are excluded. Arbitrary per-user document ACLs are outside this version.

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

Knowledge retrieval is hybrid (BM25 over UA/EN terms + local hashing embeddings, fused with RRF) over heading-aware passages of published sources in the trusted business scope. A reply's `sourceRefs` conservatively cover the eligible published source snapshot because native sessions and product history can reuse earlier facts without a fresh search. Retrieval audit events separately identify the passages actually searched; precise transitive citation tracking is not implemented (see [the knowledge-base contract](KNOWLEDGE_BASE.md)). Draft/revoked documents never enter new model context. Mid-run revocation or policy/skill changes fence final output. Skills cannot enable tools or turn off refund approval. Postgres persists messages, cases, proposals, runs, audit, documents, skills and settings; DSH owns its native session store separately.
Demo records are seeded only with `DEMO_RESET_ENABLED=true` (development default; production default false). Clean production setup creates a business and customers through the authenticated administration API; public demo session tokens are not provisioned automatically.
`SUPPORT_EXECUTION=worker` requires PostgreSQL and the worker process; it is the PostgreSQL default. `SUPPORT_EXECUTION=inline` is an explicit local demo option and the default for the memory store. Run the complete release migration chain through `0008_integrations` before starting API or worker: support state, durable turns, classification, insights, knowledge, external knowledge and integration state. PostgreSQL startup checks reject missing required schema.

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
- `Proposal {id, caseId, tool, args, argsHash, risk: low|high, status: pending|approved|executing|executed|rejected|failed|denied|unknown|expired|invalidated, policy: {allowed, requiresApproval, checks: [{name, passed, detail}]}, authorizationOrigin?: policy_auto|operator_approval|null, decidedBy, decidedAt, result, error, createdAt}`
- `AgentRun {provider, model, status: ok|fallback|failed, steps, toolCalls, latencyMs, error}`
- `AuditEvent {type, actor, data, createdAt}` — types: `case.opened, message.received, agent.analyzed, agent.fallback, action.proposed, action.denied, action.approved, action.rejected, action.executed, action.failed`
- `Refund {paymentId, proposalId, amountCents, providerRef, simulated: true}`

## Tools (registry: `apps/api/src/modules/agent/tools.ts`)
| Tool | Kind | Risk | Gate |
|---|---|---|---|
| `lookup_payments {limit}` | read | low | scoped to session customer, runs inside the model loop |
| `refund_payment {payment_id, amount_cents}` | write | high | policy + human approval, executed by backend only |
| `escalate_to_human {reason}` | write | low | policy, auto-executed |

## Integration catalog administration

These routes require the operator bearer and an explicit `?businessId=<uuid>` on every integration URL. The current bearer is a deployment-wide administrator; selecting a business scopes the resource, rather than providing separate tenant authorization. Errors use 401 for invalid staff auth, 404 for a missing business/integration/manifest, 409 for optimistic-version conflicts or a failed catalog-readiness check, and 422 for invalid bodies. URL paths below omit `/api/v1`.

`IntegrationSummary` is `{businessId,integrationId,enabled,draining,activeManifestHash:string|null,loadedManifestHash,connectionRevision:string,policyRevision:number,defaultMode:auto|ask|deny,version:number,updatedAt}`. The connection revision is a decimal string. The mutable `version` is the compare-and-swap token for every edit, while `policyRevision` identifies execution rules. Manifest hashes identify immutable operation definitions. Secrets, connector credentials and raw private OpenAPI are excluded from responses.

| Method | Path | Body / result |
|---|---|---|
| GET | `/integrations?businessId=…` | `{integrations:IntegrationSummary[]}` |
| GET | `/integrations/:id/operations?businessId=…` | `{integration,groups,operations}`; each operation contains its sanitized manifest definition plus `enabled`, `reviewedOperationHash`, configured `mode` and server `effective` decision |
| GET | `/integrations/:id/policy?businessId=…` | `{integration:IntegrationSummary,policy:IntegrationPolicy}` |
| PATCH | `/integrations/:id/policy?businessId=…` | `{version,manifestHash?,defaultMode?,groups?,operations?:[{operationKey,mode,operationHash?}]}` → `{integration,policy}` |
| POST | `/integrations/:id/review?businessId=…` | `{version,manifestHash,operations:[{operationKey,operationHash,enabled}]}` → `{integration,policy}` |
| POST | `/integrations/:id/activate?businessId=…` | `{version,manifestHash,connectionRevision}` → `{integration,policy}` after live connector manifest/tool-schema verification |
| POST | `/integrations/:id/disable?businessId=…` | `{version,draining?:boolean}` → `{integration,policy}`; draining defaults to true |
| GET | `/integrations/:id/audit?businessId=…` | `{events}` for the selected integration |

`IntegrationPolicy` contains `integrationId,businessId,enabled,manifestHash,policyRevision,defaultMode,groups,operations`. A group is `{id,selector:{tag:string}|{operationKeys:string[]},mode}`. A stored operation rule is `{operationKey,enabled,reviewedOperationHash:string|null,mode}`. The default accepts `auto|ask|deny`; group/operation rules also accept `inherit`. PATCH `groups` replaces the group array without enabling or reviewing operations and preserves endpoint overrides. Explicit operation Ask/Auto with matching `manifestHash` and `operationHash` atomically sets the mode, enables and reviews that exact known-effect definition; invalid, partial or stale proof rejects the whole edit. Deny disables the operation and clears its reviewed hash. Legacy edits without proof retain the existing review gate; `inherit` never grants access.

The operations response includes `operationKey,operationId,toolName,method,path,title,description,tags,effect,operationHash,inputSchema,parameters,scope,outputFields,guard,idempotency,reconciliation`. `effective` is `{mode,source:operation|group|integration|guard,matchedRuleIds,policyRevision,reasonCode}`. Explicit operation mode takes precedence over group defaults. Multiple applicable group modes use `deny > ask > auto`; `group_conflict_strictest` and matched group IDs explain that result. Server guards, business/customer ownership, integration activation and exact-hash review apply independently of permission mode.

A new or changed operation starts at Deny, disabled and unreviewed, regardless of group/default modes. Exact proof on an explicit Ask/Auto save replaces the separate per-operation review step; the legacy review endpoint remains compatible and cannot approve an unknown effect or resurrect a revoked Auto grant. Activation separately checks the loaded manifest, connection revision and actual sidecar catalog; policy saves never activate the integration. A stale `version` never overwrites current edits: reread policy/catalog and submit a new explicit edit. Clients reading operations and policy separately should verify their integration versions match before enabling controls.

### External proposals and reconciliation

External proposals retain `tool:"external_action"`. Their `args` is the frozen invocation snapshot directly, including operation/integration identity, title, reviewed hashes, policy and connection revisions, input, trusted scope/ownership and `expiresAt`. The UI shows the operation title, target and important input values, rather than the generic tool discriminator. `authorizationOrigin` distinguishes `policy_auto` from `operator_approval`; actor/timing and policy checks remain available. `approved` means consent was recorded, while `executed` means a result was durably confirmed. Approval and execute remain separate existing endpoints with the exact proposal `argsHash`.

`expired` and `invalidated` are terminal proposal states: expiry requires a new proposal; changes to policy/catalog/ownership can invalidate a snapshot. An `unknown` outcome is not retried automatically. After verifying the actual upstream result, an operator can use:

```http
POST /api/v1/proposals/:id/reconcile
Authorization: Bearer <OPERATOR_TOKEN>
Content-Type: application/json

{"status":"executed","reason":"Verified the provider operation record","providerRef":"provider-reference"}
```

The body is `{status:"executed"|"failed",reason:string(3..500),providerRef?:string(1..200),result?:object}`. Only an external proposal currently in `unknown` can be reconciled. Optional result data is projected through the recorded operation's approved output fields. The response is `{proposal,case}`. This endpoint records the verified outcome, customer message and audit; it does not dispatch another upstream request. Concurrent/stale reconciliation returns 409.


## Fixed workspace, editable skills, guards and agent activity

`SUPPORT_WORKSPACE_BUSINESS_ID` binds a deployment to one server-selected business.
Authenticated `GET /api/v1/workspace` returns `{business:{id,slug,name,currency}}`.
Without an explicit binding, the operator workspace requires exactly one stored
business; ambiguity returns409. The UI does not choose the first business or
retarget itself from a `businessId` URL. A configured binding also limits case,
customer, proposal, metrics, team, knowledge, settings, insights and integration
reads/writes; it is not only a hidden selector. Foreign references are rejected.
Legacy unbound administration APIs retain their existing scope rules.

| Method | Operator path | Contract |
| --- | --- | --- |
| PATCH | `/api/v1/skills/:id` | `{revision,content,enabled}` → stored skill with revision+1; stable id/name,409 on stale revision |
| GET | `/api/v1/guards` | `{version,revision,rules,definitions}`; settings CAS version and separate guard-policy revision |
| PUT | `/api/v1/guards` | `{version,rules}` → newer settings/guard revisions; validation and409 conflicts do not execute business effects |

These scoped resource routes can use the configured workspace without a query
parameter. Supplying a foreign business ID cannot override the binding. Skills
remain prose. Guard rules instantiate registered, versioned deterministic kinds:
`deny_action`, `amount_limit` and `require_approval`. The last kind can strengthen
an external operation's approval requirement; it cannot weaken mandatory refund
approval. Code bootstrap uses versioned `guardPolicies`, and preserves newer
operator edits. See [banking setup](BANKING_SANDBOX.md).

`CaseDetail.agentActivity` is a bounded application DTO with
`status:recorded|not_recorded`, `events` and `hasMore`. Events correlate a run and
optional tool call, request IDs and proposal ID; record context revisions, safe
input/result facts, server checks, brief decision reasons and fallback/failure
provenance. Server/provider results are distinct from model claims. An attempted
or proposed operation is not an executed effect. Historical runs without this
recording say `not_recorded`; raw native sessions, thought signatures and private
chain-of-thought are not the operator API. More than100 retained events are
reported through `hasMore`, rather than pretending the displayed subset is the
whole history.
