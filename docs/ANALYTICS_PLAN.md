# Product analytics plan (PostHog) — decision record

**Status:** accepted as the plan; **not implemented**. Build it only after the MVP E2E and the desktop/mobile UI are stable (priority 4 of 4).
**Owner:** WS1 (`packages/analytics`, server telemetry wiring). No workstream adds tracking calls before then.

## Decision
- **One tracking API.** Clients keep calling the existing typed facade in `packages/analytics` (`initAnalytics(env, surface)` → `Analytics`). Add a PostHog provider behind it, next to the current Umami one. Call sites never import `posthog-js` directly, and every event goes through a typed method, never through free-form `track(name, props)`.
- **Business metrics come from the server.** Case resolution, escalation, resolution time and action success are facts the backend already records in the audit log. One server-side observer turns audit events into PostHog events (`posthog-node`). There is no browser-side guessing.
- **Privacy by construction:**
  - no autocapture, no session replay, no heatmaps or surveys;
  - pageviews only through the existing `sanitizeAnalyticsUrl` (query strings except `utm_*` are dropped);
  - never call `identify`, so events stay anonymous; a random per-tab id is enough;
  - IP discarding is enabled in the PostHog project.
- **Properties are enums, booleans and numbers only.** Never message text, names, emails, session tokens, payment ids, amounts or card data. Case ids are sent only as a salted hash.
- **Configuration:** `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST` (the project key is public by design) for browsers; `POSTHOG_KEY`, `POSTHOG_HOST` for the API. Empty values → analytics disabled, the app works unchanged (same rule as Umami).

PostHog client options to verify against the current docs at implementation time: `autocapture: false`, `capture_pageview: false`, `disable_session_recording: true`, `persistence: 'memory'`, `person_profiles: 'identified_only'` (and never identify).

## Event schema
| Event | Source | Properties (all non-personal) |
|---|---|---|
| `landing_viewed` | landing (exists today) | `surface`, `utm_*` |
| `landing_cta_clicked` | landing (exists today) | `location: header\|hero\|footer`, `utm_*` |
| `demo_started` | app, first load of `/chat` or `/operator` | `surface: chat\|operator`, `viewport: mobile\|tablet\|desktop` |
| `chat_message_sent` | app chat | `length_bucket: <50\|50-200\|>200` |
| `proposal_decided` | app console | `tool`, `decision: approve\|reject`, `outcome: 200\|409\|502` |
| `demo_completed` | app, when the open case reaches `resolved` or `escalated` | `surface`, `final_status: resolved\|escalated` |
| `case_opened` | server ← `case.opened` | `business_slug` |
| `agent_run_completed` | server ← `agent_runs` | `provider`, `model`, `status: ok\|fallback`, `steps`, `latency_ms`, `intent`, `sentiment_label`, `priority` |
| `action_proposed` | server ← `action.proposed` / `action.denied` | `tool`, `risk`, `allowed`, `failed_checks: string[]` (check names only) |
| `action_executed` | server ← `action.executed` / `action.failed` | `tool`, `success: boolean`, `failure_kind: provider\|policy_recheck\|null` |
| `case_escalated` | server ← case status → `escalated` | `reason: policy_denied\|abusive\|unsupported\|provider_failure` |
| `case_resolved` | server ← case status → `resolved` | `resolution_time_s`, `actions_executed` |

## Metric definitions
| Metric | Formula |
|---|---|
| Demo CTR | unique `landing_cta_clicked` / unique `landing_viewed` |
| Demo completion | `demo_completed` / `demo_started` (per anonymous session) |
| Case resolution rate | `case_resolved` / `case_opened` |
| Escalation rate | `case_escalated` / `case_opened` |
| Resolution time | median and p90 of `case_resolved.resolution_time_s` |
| Action success rate | `action_executed{success=true}` / `action_executed` |

Until PostHog is live, the slides use only `GET /api/v1/metrics` (measured from stored state) and the WS4 eval output.

## Integration points (when implemented)
1. `packages/analytics/src/index.ts`: add the provider adapter and the typed methods `trackDemoStarted`, `trackChatMessageSent`, `trackProposalDecided`, `trackDemoCompleted`. Unit tests check that no forbidden property can be passed (types plus a runtime allow-list).
2. `apps/frontend`: one call per event at the four listed points (WS2 files, after the UI is frozen).
3. `apps/api/src/modules/support/telemetry.ts` (new, WS1): wraps `SupportStore.audit`/`recordRun`/`updateCase` in `factory.ts` and maps them to the server events. `harness.ts`, the contracts and the routes are not touched. Failures are swallowed: analytics never blocks a support action.
4. `.env.example` + `compose.yaml`: the four variables, empty by default.
5. Landing: no change needed; the existing CTA events cover Demo CTR.
