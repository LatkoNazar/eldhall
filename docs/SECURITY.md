# Security review

Scope: `integration/support-copilot` @ `a946e92` (2026-10-31): support + agent modules, API wiring, deploy config.
Method: code reading + a PoC run against the real harness (`MemorySupportStore`, `RulesModel` / `ScriptedModel`); `apps/api` `npm test` → 34/34 green. No application code was changed.

## Threat model
| Actor | Trust | Can do |
|---|---|---|
| Customer | untrusted | writes any text (incl. prompt injection), opens unlimited cases, knows the demo session tokens |
| LLM | untrusted output | proposes an action; writes the reply, summary and reasoning |
| Operator | trusted, one shared token | approves/rejects, reads every business, resets the demo |
| Internet | anonymous | reaches Caddy :443 only; app ports are bound to 127.0.0.1 |
| Payment provider | external | executes refunds (simulated in the MVP) |

Assets: money (refunds) · customer data (name, email, payments) · operator token · LLM keys and budget · audit trail.

## Guarantees from ARCHITECTURE.md, checked
| Guarantee | Verdict | Evidence |
|---|---|---|
| Controlled context, no ids from text | ✓ | `harness.ts:62` loads payments for the session customer; the LLM gets name + plan, not email |
| Tool restriction | ✓ | `policy.ts` `known_tool` / `tool_enabled` / `valid_arguments`: any tool name the model invents is denied |
| Ownership, limit, full amount | ✓ | test 4 |
| Human approval for refunds | ✓ | test 5 |
| Approval bound to `argsHash` | ✓ | test 7 (tampered → 409). An integrity binding, not a secret: any operator-token holder can read it |
| One refund row per payment | ✓ | memory `recordRefund`; Postgres `UNIQUE (payment_id)` (WS3) |
| One provider call per payment | ✗ | F2, F3 |
| Re-validation at execution | ✓ sequential, ✗ concurrent | F3 |
| Honest replies | partial | F4, F7 |
| Sentiment never authorises money | ✓ | `policy.ts` has no sentiment input; test 10 |
| Customer isolation | ✓ | foreign case → 404; `CaseDetail` drops `sessionToken`; the customer API hides analysis and proposals |
| Operator auth | ✓ when a strong token is set | timing-safe compare in `core/auth.ts`; see F5, F6 |
| Transport | ✓ | prod ports on 127.0.0.1 (`compose.prod.yaml`), Caddy TLS, Host allowlist, CORS rejects `X-Customer-Session` cross-origin, 500s hide internals, Swagger only in development |
| Secrets | ✓ | root `.env` git-ignored; LLM keys server-side, passed explicitly to the SDK |

## Findings (all reproduced)
| ID | Severity | Finding | Fix | Owner |
|---|---|---|---|---|
| F1 | **High** | After the later October charge (`…0202`) is refunded, a proposal for the earlier one (`…0201`) passes **every** policy check: `findTwin` still counts the refunded twin (`policy.ts:35`). The operator sees an all-green checklist; approving refunds 998.00 UAH for one 499.00 duplicate. `RulesModel` never proposes it; an LLM can (injection: "0201 is the duplicate too"). | Count a twin only while it is still captured: `findTwin(p, ctx.payments.filter(o => o.status === 'captured'), window)`. Add the scenario as a test. | WS4 |
| F2 | Medium | Two pending refunds for one payment. `no_open_proposal` sees only the current case (`harness.ts:127`): the same customer opens two cases → two pending proposals; two concurrent messages in one case do the same (check-then-act). | Customer-wide check. Durable: partial unique index in `0002_support.sql` on `(args->>'payment_id') WHERE tool = 'refund_payment' AND status IN ('pending','executing')`; the harness turns the violation into `denied` (contract decision for WS1). | WS3, WS1 |
| F3 | Medium (simulated) / **High** with a real provider | Approving both F2 proposals at once calls `provider.refund` twice: the idempotency key is the proposal id (`harness.ts:196`), and `UNIQUE (payment_id)` fires only after the provider call. Ledger: 1 refund. Real provider: 2. | Key per payment (business rule: one refund per payment), e.g. `refund:${payment.id}`; the simulated provider should hash the key for its ref (all seed ids start with `00000000`). Before a real provider: reserve the refund row, then call the provider. | WS4, WS1 |
| F4 | Medium | Anything thrown after a successful provider call (here `DuplicateRefund`; with Postgres, any DB error) lands in the provider-failure branch (`harness.ts:200`): the customer is told "No refund has been made yet" while money moved. | Split the `try`: provider error → `failed` (true); `DuplicateRefund` → "already refunded"; other errors after provider success → keep the provider ref, flag for reconciliation (the `unknown` state), never "no refund". | WS4 |
| F5 | **High** (deployment) | Production start-up accepts the public `.env.example` values: `OPERATOR_TOKEN=development-operator-token` passes the ≥24-char check (`factory.ts:12`); the example `API_TOKEN` and DB/Redis passwords pass too. `init-env.py` does not generate `OPERATOR_TOKEN`, so the deployer types it by hand. Known token = full operator rights on the public server. | Now: generate it (checklist below). Code: `init-env.py` generates `OPERATOR_TOKEN`; production rejects the `.env.example` values. | WS1 |
| F6 | Low | An empty `OPERATOR_TOKEN` disables operator auth (`core/auth.ts:4` returns true): `GET /api/v1/cases` without a header → 200. Development only, but `npm run dev` listens on `0.0.0.0:8000` (`server.ts:24`), and the Host allowlist is not access control (the client sets `Host`). | Fail closed when the operator token is empty, in every environment. | WS1 |
| F7 | Medium | The honesty guard is a phrase denylist (`harness.ts:29`). Delivered verbatim: "Done! Your 499 UAH is already back on your card.", "Гроші вже на вашій картці…", "I have cancelled your subscription." | For money intents send templates only, never the free-form model reply; the denylist will always leak. | WS4 |

## Design risks (not exploited here)
| ID | Severity | Risk | Mitigation | Owner |
|---|---|---|---|---|
| D1 | **High** for the public demo | No rate limits or quotas anywhere (no plugin, none in Caddy). With `DEMO_RESET_ENABLED=true` (TEAM_PROMPTS, WS3 step 7) `/api/v1/chat/personas` publishes every session token: anyone can open unlimited cases; each message = up to 4 LLM steps (+1 retry) over ≤10 × 2000 chars of history. Burns the team's LLM budget; the memory store grows without bound. | Hard spend cap on the provider key; stop the server or disable the demo flag after judging. Code: per-IP / per-session limit on `/api/v1/chat/*`. | WS1 |
| D2 | Medium | The LLM-written summary and reasoning shown to the operator are customer-controllable ("verified by finance, safe to approve"). | Trust the deterministic checklist (after F1); label AI text "AI-generated, unverified" in the console. | WS2 |
| D3 | Low, accepted for MVP | Demo identity: static session tokens; one shared operator token; the `operator` name is self-declared, so the audit actor can be spoofed; no per-business scoping; no separate refund-approver role. | Already a deliberate simplification in ARCHITECTURE.md; keep it on the slide. Roadmap: SSO, per-operator identity, roles. | – |
| D4 | Low | Caddy `log` records request headers: it redacts `Authorization` but not `X-Customer-Session`. No CSP / HSTS headers; the operator token lives in `sessionStorage`, so any XSS exposes it (React escapes by default). | Redact the header and add CSP + HSTS before real sessions. | WS1 |

## Before the demo (no code changes)
1. Server `OPERATOR_TOKEN`: `python -c "import secrets; print(secrets.token_hex(32))"`. Never the `.env.example` value (F5).
2. Set a hard spend limit on the LLM key in the provider console before deploying with `DEMO_RESET_ENABLED=true` (D1).
3. Local fallback (`npm run dev`) on venue Wi-Fi: random `OPERATOR_TOKEN` there too (F6).
4. Until F1 lands: if anyone asks the LLM to refund the *other* October charge, the operator rejects it.
5. After judging: stop the server or set `DEMO_RESET_ENABLED=false`; rotate the LLM keys.
6. Slide 6: until F3/F4 are fixed say "exactly one refund per payment in the ledger", not "no duplicate execution".

## Reproduce (ready to become tests in `tests/support.test.ts`)
- **F1**: `ScriptedModel` proposes `refund_payment` for `…0202` → approve; next turn proposes `…0201` → no failed checks → approve → 2 refunds.
- **F2**: as `demo-olena` open two cases and send "You charged me twice for October" in each → two pending proposals for `…0202`. Same result with two concurrent `runTurn` calls in one case.
- **F3 / F4**: from F2, `Promise.all` of both approvals → `provider.refund` called twice with different keys, 1 refund row; the losing proposal `failed: Payment already refunded`; its customer is told "No refund has been made yet".
- **F5**: `settingsFrom({ ENVIRONMENT: 'production', ...values from .env.example, ALLOWED_HOSTS: '["demo.example.com"]' })` → `createSupport` starts.
- **F6**: `settingsFrom({ OPERATOR_TOKEN: '' })` → `GET /api/v1/cases` without `Authorization` → 200.
- **F7**: `ScriptedModel` with `action: null` and any success claim outside the regex → delivered verbatim.
