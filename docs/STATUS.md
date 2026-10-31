# Current implementation status

Updated 31 October 2026. Active checkout: `codex/support-mvp`, based on `a946e92` from `origin/integration/support-copilot`. These are local working-tree results, not remote CI, merge, deployment or publication claims. Current guides: [implementation/start](implementation.md), [API contracts](API_CONTRACTS.md), [runtime/configuration](integrations-runtime.md). [TEAM_PROMPTS](TEAM_PROMPTS.md) is superseded historical context.

The team landing and pitch work through `2456f71` is now incorporated locally. The table below records the earlier MVP verification checkpoint; final combined checks also cover the newer configurable classification, dedicated OpenRouter Decisions model, KB Insights and authentication changes. See [classification/configuration](integrations-runtime.md), [OpenRouter](openrouter.md) and [Insights](insights.md). The incoming [pitch deck](../deliverables/pitch/README.md) remains a historical draft until regenerated and verified against the current application. [Product analytics](ANALYTICS_PLAN.md) remains a plan; no new tracking integration is claimed.

| Area | Implemented behavior | Verification at this checkpoint |
| --- | --- | --- |
| API and guards | Scoped customer/operator APIs, deterministic refund policy, sentiment, audit, separate approval/execution | API **70/70**, zero skips; lint, typecheck and build passed |
| Persistent state | PostgreSQL messages/cases/runs/proposals/audit, KB, skills and settings; explicit migrations | Real PostgreSQL integration suite **7/7** passed |
| Background turns | Atomic message + durable outbox, BullMQ relay/worker, renewable fenced leases, bounded recovery, atomic final completion | Native E2E retained an accepted queued turn across API restart; actual BullMQ delivery and strict DSH execution observed |
| DSH runtime | Native DSH `0.2.2-alpha.2`, dedicated composition, parent gateway and native sessions | Actual runtime **5/5**, included in API suite; live Google `gemini-3.5-flash-lite` worker run **13.286 s**, labelled LLM rather than fallback |
| Financial execution | Consent bound to `argsHash`; separate execute rechecks guards and reserves payment; unknown outcomes stay locked | E2E: eight competing execute calls produced **one simulated refund and seven conflicts**; replay produced no additional refund |
| Headless config/MCP | Reviewed JSON, versioned published KB, prose skills, persisted guards, scoped read-only MCP | Real local MCP protocol tests **15/15** passed |
| Optional web clients | Six light dashboard screens, customer `/chat`, real API resources, staff handoff and proposal-based Actions | Final lint, typecheck and production build passed; frontend tests **33/33**, independently repeated **33/33** including five Actions tests. Independent browser: all six screens at desktop 1536/mobile 390, Settings at 320; **35 API responses 200**, zero JavaScript errors. Actions showed 3 actual cases/2 proposals with phase counts 1/0/1. Mobile focus return passed at 390/320 (`browser-qa-actions-focus-final.json`) |
| Starter compatibility | Landing and jobs/analytics infrastructure retained | Landing lint/typecheck/build; Node smoke **6/6**; Python **9/9**; Bash syntax **7 files**; isolated release guards **25/25** passed |
| Self-host packaging | Separate headless Compose, optional `ui` profile, persistent volumes, migration gate and read-only config overlay | Support headless/UI/config and legacy production Compose validate. **Docker engine unavailable: image build/container startup unverified** |

Runtime, MCP and PostgreSQL counts describe their respective suites; do not add them to the full API count as separate coverage totals. Private local evidence is under `.omc/artifacts/`, including `legacy-verification.json`.

## Boundaries and remaining decisions

- Payment effects are **SIMULATED**, identified by `SIM-RF-*`; no real money moves.
- Knowledge retrieval is lexical. Embeddings/pgvector are not implemented.
- One configured operator bearer maps to the bootstrap staff principal; customers use opaque session bearers. OAuth/SSO, invitations and full RBAC are not implemented.
- MCP supports configured reads only. Skills grant no executable code or permissions. The upstream server must enforce customer/business ownership.
- No Oracle/managed-cloud deployment or Docker container execution is claimed. Local integration commits do not establish remote CI or publication success.
- License and managed-cloud packaging remain undecided. [The architecture review](architecture-review.md) remains a target proposal.
