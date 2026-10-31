# Support insights and candidate knowledge gaps

AI Insights analyzes a bounded sample for one business when a staff member explicitly starts a run. It proposes recurring issues, candidate gaps in sampled published knowledge, and possible contradictions. Findings are hypotheses for review, not confirmed root causes or measurements of the whole customer population.

The generative engine is the existing pinned DSH with the configured conversational model (Gemini by default). OpenRouter `openai/gpt-6-luna-decisions` remains the separate ticket classifier; its typed probability API does not generate articles. The insights native profile exposes only `submit_insights`: no payment, refund, MCP, shell or model-facing filesystem tools. Native runtime homes are isolated from customer support sessions.

## API and processing

All routes require the existing operator bearer. Customer-session credentials grant no access.

| Method | Route under `/api/v1/insights` | Result |
| --- | --- | --- |
| POST | `/runs` | Body `{businessId, limit?:1..25, clientRequestId?:uuid}`; returns202 queued run. Same request ID/input returns the same run; changed input or another active business run returns409. |
| GET | `/runs?businessId=...` | `{runs:[...]}`, latest30 runs. |
| GET | `/runs/:runId?businessId=...` | One business-scoped run. |
| POST | `/runs/:runId/findings/:findingId/draft?businessId=...` | `{draft:KnowledgeSource}`; creates/reuses one ordinary KB draft. |

HTTP only admits, reads or creates drafts. The ordinary worker polls durable PostgreSQL analysis rows every2seconds, independently of customer-turn BullMQ delivery. PostgreSQL claims use `SKIP LOCKED`, a renewable30second lease, owner/fence checks and at most3 recovery attempts. A graceful shutdown requeues the read-only analysis; an expired crashed-worker lease permits another worker to recover it. API restart does not discard queued runs. One active run is allowed per business. The model deadline uses `LLM_TIMEOUT_MS`; model errors or invalid output produce a failed run with an owned error, never fabricated fallback findings.

Insights requires the PostgreSQL support store and configured DSH provider. Apply migration `0005_insights.sql` through the normal migration runner before restarting API and worker. With no eligible dialogue, the worker completes an empty result without a model call.

## Evidence and sample limits

The sample selects up to25 recently updated nonempty tickets for the requested business, up to8 latest messages per ticket, and up to20 published KB excerpts of1200characters. Messages are capped at600characters; the combined context is bounded. Email addresses and common API-key patterns receive best-effort masking, which is not a guarantee of complete personal-data anonymization. Customer profiles, session credentials and payment records are not included. Connect a local model if business data must stay within your infrastructure.

The result records actual sampled/total eligible ticket counts, sampled/total published KB counts, message count, included message date bounds and truncation. These are sample counts, not prevalence estimates. A candidate gap means insufficient guidance in these excerpts; it does not establish absence from the entire KB.

Every finding must cite ticket/message IDs present in that exact input. Each cited message must belong to the cited ticket. Counts derive from unique validated ticket IDs; a recurring issue requires two distinct tickets. Possible contradictions require a sampled KB version. Unknown/cross-business references, extra action fields, excessive prose and malformed output fail validation.

Only currently published KB contributes. Assistant messages derived from changed/revoked sources are omitted. Source versions are checked again under database locks at completion and draft creation. If a referenced source later changes, reads hide derived findings and mark the run stale; staff must run analysis again. Previously created drafts remain ordinary staff-managed KB documents and include AI/source provenance and a verification notice. This module does not claim to revoke or prohibit publication of a draft a staff member already controls.

## Review before publication

The optional proposed article is an unpublished suggestion. Creating a draft is idempotent per finding, including concurrent requests. It carries analysis/finding/evidence/source-version provenance. Staff should verify claims, replace unknown business facts and use the existing KB edit/publish workflow. Analysis never publishes documents, alters policies or roles, sends customer replies, or executes refunds.

The optional dashboard exposes these actions in the Analytics insights view while retaining the six main navigation screens. Staff choose a business and manually start an analysis. Queued/running results poll for a bounded period; manual refresh remains available. Failed and empty results are explicit. Evidence links open the cited conversation, including a ticket outside the current inbox page. Before creating a draft, the UI rereads the run and blocks stale findings. A created-draft link opens the ordinary Knowledge interface, where staff review, edit and explicitly publish it. No publish request is part of the Insights draft flow.

Headless clients can use the same API without the web container. [API contracts](API_CONTRACTS.md), [implementation guide](implementation.md), [current status](STATUS.md).

## Verification commands

From the repository root, `npm --prefix apps/api run test:runtime` includes the actual installed DSH insights profile against a local compatible-model fixture. `npm --prefix apps/api run test:postgres` includes the real PostgreSQL/API insights suite in an isolated temporary schema. PostgreSQL tests require working private `POSTGRES_*` or `TEST_POSTGRES_*` configuration and fail rather than skip when the database is unavailable. The regular API suite includes pure evidence-validation tests; frontend tests cover the manual run, polling, evidence, stale checks and draft-only flow. A live external-model/ordinary-worker scenario is a separate integration check and must be reported independently.
