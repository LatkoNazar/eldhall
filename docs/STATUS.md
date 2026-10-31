# Current implementation status

Updated 31 October 2026. Local integration combines the implemented support changes with team work through `2456f71`; source integration was committed on `codex/support-mvp` before final publication. Results below are local verification, not a claim of remote CI, cloud deployment or Docker container execution. Current guides: [implementation/start](implementation.md), [API contracts](API_CONTRACTS.md), [runtime/configuration](integrations-runtime.md). [TEAM_PROMPTS](TEAM_PROMPTS.md) is superseded historical context.

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
- MCP supports configured reads only. Skills grant no executable code or permissions. The upstream server must enforce customer/business ownership.
- No Oracle/managed-cloud deployment or Docker container execution is claimed. Local integration commits do not establish remote CI or publication success.
- License and managed-cloud packaging remain undecided. [The architecture review](architecture-review.md) remains a target proposal.
