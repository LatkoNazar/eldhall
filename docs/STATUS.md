# Current implementation status

Updated 4 November 2026. The OpenAPI implementation and final approval-turn/release safeguards are accepted and deployed. [PR #9](https://github.com/LatkoNazar/eldhall/pull/9) introduced the implementation; [PR #10](https://github.com/LatkoNazar/eldhall/pull/10) merged the final accepted source `027f92f` into `main` at `2ba80ca`. Current guides: [implementation/start](implementation.md), [OpenAPI onboarding](OPENAPI_QUICKSTART.md), [API contracts](API_CONTRACTS.md), [runtime/configuration](integrations-runtime.md). [TEAM_PROMPTS](TEAM_PROMPTS.md) is superseded historical context.

## OpenAPI integration checkpoint

Implemented: deterministic local OpenAPI import and normalized artifacts; authenticated Python MCP sidecar with fixed target and registered guards; PostgreSQL-authoritative policy/review/activation; operator API and Integrations UI; durable external actions, completion deduplication, expiry/invalidation and manual reconciliation. A new operation starts disabled regardless of an integration/group auto rule. An `ask` read or write saves its proposal and ends the bounded turn with application-owned pending control, blocking dependent tools and builtin actions. Legacy MCP connections retain their read-only contract.

| Check | Verification result |
| --- | --- |
| Full API suite, bounded file concurrency | 192 tests: 191 passed, zero failures, one local pgvector test requiring a PostgreSQL fixture |
| API lint, typecheck, production build | Passed |
| Frontend suite, lint, typecheck, production build | 80 tests passed; all checks passed |
| Python importer/sidecar suite and pinned Ruff lint | 32 tests passed, zero skips; lint passed |
| Native DSH fixture suite | 10 tests passed, including approval termination and untrusted-result collision checks (also part of the full API suite) |
| Node → Python MCP → synthetic Orders API | 6 integration tests passed, including upstream target/revision mismatch |
| Config generator and JavaScript syntax | Validated against the compiled backend schema |
| Host deployment utilities and Linux release/rollback harness | 31 unit tests and 28 release cases passed in final ARM64 CI, including legacy queue draining and failure recovery |

PostgreSQL race/recovery tests and standalone Compose acceptance are mandatory CI gates on the configured ARM64 runner. The [final source run](https://github.com/LatkoNazar/eldhall/actions/runs/41831320974) for `027f92f` passed all three mandatory jobs (`check`, `integration`, `sidecar-compose`): PostgreSQL 29/29, pgvector knowledge 13/13, Python 32/32 with Ruff, cross-language MCP 6/6, and actual standalone Compose build/startup/smoke. The [main run](https://github.com/LatkoNazar/eldhall/actions/runs/41832367634) repeated all three gates successfully for `2ba80ca` and completed production deployment. The standalone MCP smoke uses only synthetic Orders data and a scripted model. Local Docker Desktop remains unavailable; container evidence comes from CI and the deployed host.

The [post-deployment diagnostics](https://github.com/LatkoNazar/eldhall/actions/runs/41834098842) verified `/opt/apps/starter/current` and its `image.ref` both identify `2ba80ca4c727c8b52ac1a91e6f8296f287487efd`. API, worker, frontend, landing, PostgreSQL, Redis, Umami and its database are running and healthy; Caddy is running (it has no configured healthcheck). Public readiness, operator UI and customer chat routes returned 200. The integration route rejects unauthenticated access with 401; these checks concern the replacement release, rather than the prior application's still-healthy endpoints.

The legacy RabbitMQ container and storage remain available for rollback. Post-deployment counts show zero consumers, ready messages and unacknowledged messages; SQL has six succeeded jobs (the prior four plus two new smoke jobs), with zero queued, running, failed or other states. The deployed cutover stops old API ingress, drains verified SQL/broker work, stops the old worker and rechecks before backup/migration. These post-deployment counts are a snapshot, not a guarantee about future traffic.

Earlier attempts in [run 41822733941](https://github.com/LatkoNazar/eldhall/actions/runs/41822733941) stopped on missing deployment configuration before replacement startup. [Configuration initialization](https://github.com/LatkoNazar/eldhall/actions/runs/41830073651) preserved existing values and added the absent Umami secrets and operator token with a private backup. Those configuration failures were repaired before the successful rollout above and are historical, not current blockers.

The starter rollout does not enable a business connector automatically: the MCP overlay, reviewed artifacts, credentials and activation remain explicit deployment steps. Production connector activation is not claimed by these application-health checks. PRs #6 and #7 were closed after confirming their source ancestry was preserved; PRs #9 and #10 are merged, and the final repository check found no open PRs.

## Previous baseline (31 October 2026)

See [classification/configuration](integrations-runtime.md), [OpenRouter](openrouter.md) and [Insights](insights.md) for the implemented additions. The incoming [pitch deck](../deliverables/pitch/README.md) remains a historical draft until regenerated and verified against the current application. [Product analytics](ANALYTICS_PLAN.md) remains a plan; no new tracking integration is claimed.

| Area | Implemented behavior | Verification at this checkpoint |
| --- | --- | --- |
| API and guards | Scoped customer/operator APIs, fail-closed staff access, deterministic refund policy, sentiment, audit, separate approval/execution | Full API **106/106**, zero skips/todos; lint, typecheck and build passed |
| Persistent state | PostgreSQL cases/runs/proposals/KB/settings, classifier watermarks and Insights; explicit migrations | Independent real PostgreSQL: support **9/9**, Insights **8/8** passed |
| Background turns | Atomic message + durable outbox, BullMQ relay/worker, renewable fenced leases, bounded recovery, atomic final completion | Native E2E retained an accepted queued turn across API restart; actual BullMQ delivery and strict DSH execution observed |
| DSH runtime | Native DSH `0.2.2-alpha.2`, dedicated compositions, parent gateway and native sessions | Actual native runtime **7 cases** included in API suite: support6 + Insights1. Live Google `gemini-3.5-flash-lite` worker run passed, labelled LLM rather than fallback |
| Financial execution | Consent bound to `argsHash`; separate execute rechecks guards and reserves payment; unknown outcomes stay locked | E2E: eight competing execute calls produced **one simulated refund and seven conflicts**; replay produced no additional refund |
| Headless config/MCP | Reviewed JSON, versioned published KB, prose skills, persisted guards, scoped read-only MCP | Real local MCP protocol, scoping and configuration checks pass within the full API suite |
| Ticket classification | Business classes1–5/other or custom IDs, revision/tombstone protection, immutable result snapshots and review fallback | Real `openai/gpt-6-luna-decisions` and ordinary worker classified synthetic delivery as class2 with score0.99; this is a model score, not an accuracy benchmark |
| AI Insights | Manual business-scoped PG queue/worker analysis, bounded repeatable-read sample, validated problem/KB evidence and draft-only action | Live ordinary worker:3 tickets/6 messages/1 KB excerpt; one candidate gap with2 evidence tickets. Six competing draft requests created one KB draft; unauthenticated access returned401 |
| Optional web clients | Six light dashboard screens, customer `/chat`, real API resources, classification, Insights and proposal-based Actions | Final frontend **52/52**, lint, typecheck and production build passed after incoming landing integration. Browser checks cover desktop/mobile navigation, Actions and focus restoration; dedicated current-feature checks cover the Insights/draft flow. Landing lint/typecheck/build passed with the corrected illustrative two-phase walkthrough |
| Starter compatibility | Landing and jobs/analytics infrastructure retained | Landing lint/typecheck/build; Node smoke **6/6**; Python **9/9**; Bash syntax **7 files**; isolated release guards **25/25** passed |
| Self-host packaging | Separate headless Compose, optional `ui` profile, persistent volumes, migration gate and read-only config overlay | Support headless/UI/config and legacy production Compose validate. **Docker engine unavailable: image build/container startup unverified** |

Runtime, MCP and PostgreSQL counts describe their respective suites; do not add them to the full API count as separate coverage totals. Private local evidence is under `.omc/artifacts/`, including `legacy-verification.json`.

## Boundaries and remaining decisions

- Payment effects are **SIMULATED**, identified by `SIM-RF-*`; no real money moves.
- Knowledge retrieval is hybrid (BM25 + embeddings, RRF) with audience/plan scoping; embeddings are local by default or OpenAI/Google, stored in pgvector when the extension is present (`compose.knowledge.yaml`), otherwise in memory. See `docs/KNOWLEDGE_BASE.md`.
- One configured operator bearer maps to the bootstrap staff principal; customers use opaque session bearers. OAuth/SSO, invitations and full RBAC are not implemented.
- Legacy MCP supports configured reads only; reviewed OpenAPI catalogs use a separate policy, approval and execution ledger for writes. Skills grant no executable code or permissions. The upstream server must enforce customer/business ownership and atomic business guards.
- ARM64 container execution is verified in CI. The current production rollout status is recorded above; public registry publication and AMD64 runtime support still require their own release evidence.
- The owner selected Apache-2.0 for the code and public Docker Hub images under `latkonazar`. License/attribution inventory and public publication remain release tasks; no public image is claimed here. [The architecture review](architecture-review.md) remains a target proposal.
