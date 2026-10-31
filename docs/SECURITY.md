# Security review

Scope: `feat/ws-security` (2026-10-31, includes the support MVP from `main`): support and agent modules, staff auth, configuration, deploy config.
Method: code reading of `core/auth.ts`, `core/config.ts`, `modules/support/factory.ts`, `modules/support/store.ts`, `modules/agent/policy.ts`, `modules/agent/harness.ts`, plus the verification recorded in [STATUS](STATUS.md). This document supersedes the review of `a946e92`; references are to functions, not line numbers.

## Threat model
| Actor | Trust | Can do |
|---|---|---|
| Customer | untrusted | writes any text (incl. prompt injection), opens cases, knows the demo session tokens |
| LLM | untrusted output | proposes an action; writes the reply, summary and reasoning |
| Operator | trusted, one shared token | approves/rejects/executes, reads every business, resets the demo |
| Internet | anonymous | reaches Caddy :443 only; app ports are bound to 127.0.0.1 |
| Payment provider | external | executes refunds (simulated in the MVP, `SIM-RF-*`) |

Assets: money (refunds) · customer data (name, email, payments) · operator token · LLM keys and budget · audit trail.

## Guarantees from ARCHITECTURE.md, checked
| Guarantee | Verdict | Evidence |
|---|---|---|
| Controlled context, no ids from text | ✓ | `harness.ts` `policyContext` loads payments for the session customer; the LLM gets name + plan, not email |
| Tool restriction | ✓ | `policy.ts` `known_tool` / `tool_enabled` / `valid_arguments`: invented tool names are denied |
| Ownership, limit, full amount, real duplicate | ✓ | `evaluatePolicy`; `findTwin` counts a twin only while it is still `captured` (F1) |
| Human approval for refunds | ✓ | `decideProposal` → separate `executeApproved` |
| Approval bound to `argsHash` | ✓ | tampered hash → 409. An integrity binding, not a secret |
| Sequential duplicate refund proposals | ✓ | `no_open_proposal` checked customer-wide (F2); concurrent proposal creation can still race, execution remains atomically reserved |
| One provider call per payment | ✓ | `claimExecution` reserves proposal and payment atomically before `provider.refund` (F3) |
| Re-validation at execution | ✓ | `execute` re-runs `evaluatePolicy` on current state |
| Honest replies | ✓ for money intents | templates only for money/action intents; free text still filtered by `CLAIMS_SUCCESS` (F4, F7) |
| Sentiment never authorises money | ✓ | `policy.ts` has no sentiment input |
| Customer isolation | ✓ | foreign case → 404; `CaseDetail` drops `sessionToken`; customer API hides analysis and proposals |
| Operator auth | ✓ | `staffTokenMatches`: timing-safe, fails closed on empty token (F6); production rejects example tokens (F5) |
| Transport | ✓ | prod ports on 127.0.0.1, Caddy TLS, Host allowlist, CORS rejects `X-Customer-Session` cross-origin, 500s hide internals, Swagger only in development |
| Abuse limits | partial | per-process chat limiter (D1) |
| Secrets | ✓ | root `.env` git-ignored; LLM keys server-side only |

## Findings
| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | A proposal for the earlier October charge passed every check after the later one was refunded: `findTwin` counted the refunded twin. | **Fixed**: `findTwin` requires both payments to be `captured` (`policy.ts`). |
| F2 | Medium | `no_open_proposal` saw only the current case: two cases → two pending refunds for one payment. | **Mitigated for sequential requests**: `policyContext` collects open refund proposals across all of the customer's cases (`harness.ts`). Concurrent turns in different cases can still pass this read-before-create check; atomic execution reservation (F3) is the actual one-provider-call guarantee. |
| F3 | Medium (simulated) / High with a real provider | Two concurrent approvals called `provider.refund` twice before `UNIQUE (payment_id)` fired. | **Fixed**: `claimExecution` reserves the proposal and the payment atomically before the provider call (memory and Postgres stores). STATUS: 8 competing executes → 1 simulated refund, 7 conflicts. |
| F4 | Medium | Any error after a successful provider call told the customer "No refund has been made yet". | **Fixed**: only `ProviderError` → `failed`; any other error → `unknown`, case escalated, re-execution locked for manual reconciliation. Interrupted executions are recovered as `unknown` (`recoverInterruptedExecutions`). |
| F5 | High (deployment) | Production accepted the public `.env.example` tokens. | **Fixed**: `isExampleToken` rejects example/placeholder values for `OPERATOR_TOKEN` (`factory.ts`) and `API_TOKEN` (`config.ts`) in production; length and whitespace checks remain. |
| F6 | Low | An empty `OPERATOR_TOKEN` disabled operator auth. | **Fixed for staff APIs**: support and Insights routes use `staffTokenMatches`, which fails closed. The legacy jobs endpoint keeps `tokenMatches` (optional token) unchanged. |
| F7 | Medium | The honesty guard was a phrase denylist; success claims leaked verbatim. | **Hardened in this branch**: refund, duplicate-charge, subscription-cancel and billing intents get template replies when no action was proposed (refund outcomes come only from `executeApproved`); `CLAIMS_SUCCESS` widened (EN/UK) for the remaining free text. A denylist is still not a proof. |

## Design risks
| ID | Severity | Risk | Mitigation |
|---|---|---|---|
| D1 | Medium (was High) | LLM budget and memory exhaustion via chat. | **Mitigated in this branch**: in-memory limit on `POST /api/v1/chat/*`, 20/min per session and 60/min per socket IP. Forwarding headers are not trusted, so clients behind Caddy share its IP budget; deploy an edge limiter with explicitly configured proxy trust before scaling public traffic. GET polling and operator routes are not limited. Identity storage is capped at 10,000 live windows with fail-closed admission; an exceeded IP limit prevents session-bucket allocation. Per process only: not shared across instances or restarts. Keep a hard spend cap on the LLM key. |
| D2 | Medium | LLM-written summary and reasoning shown to the operator are customer-controllable ("verified by finance, safe to approve"). | Trust the deterministic checklist; label AI text as unverified in the console. |
| D3 | Low, accepted for MVP | One shared operator token, no per-operator identity or RBAC; the audit actor name is self-declared; no separate refund-approver role. | Roadmap: per-operator identity, roles, approval thresholds, SSO. |
| D4 | Low | Caddy `log` redacts `Authorization` but not `X-Customer-Session`. No CSP / HSTS; the operator token lives in `sessionStorage`, so an XSS would expose it (React escapes by default). | Redact the header and add CSP + HSTS before real customer sessions. |

## Before the demo
1. Server `OPERATOR_TOKEN` and `API_TOKEN`: `python -c "import secrets; print(secrets.token_hex(32))"`. Production refuses example values (F5).
2. Set a hard spend limit on the LLM key; the chat limiter is per process (D1).
3. Local fallback (`npm run dev`) on venue Wi-Fi: still set a random `OPERATOR_TOKEN`; staff APIs fail closed without one (F6).
4. In the pitch say "simulated refund, one per payment", never "money returned".
5. After judging: stop the server or set `DEMO_RESET_ENABLED=false`; rotate the LLM keys.
