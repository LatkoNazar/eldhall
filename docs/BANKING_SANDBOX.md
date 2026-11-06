# Single-workspace banking sandbox

This example uses real Gemini inference with synthetic banking records and a
simulated refund provider. It is not connected to a real bank or payment network.
All operator surfaces bind to one deployment-owned workspace; old database
businesses are retained without appearing in the configured workspace.

## Explicit runtime configuration

```dotenv
SUPPORT_CONFIG_FILE=/config/banking/support.config.json
SUPPORT_WORKSPACE_BUSINESS_ID=b1000000-0000-4000-8000-000000000001
LLM_PROVIDER=google
AGENT_RUNTIME=dsh
LLM_MODEL=gemini-3.1-flash-lite
LLM_TIMEOUT_MS=60000
```

Supply `GEMINI_API_KEY` through your existing secret mechanism. Do not put it in
skills, knowledge, source files, operator forms or URL query parameters. Production
operator credentials retain their existing requirements. The public key `1111`
is only for the existing loopback development launcher.

The requested stable model is documented by
[Google](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite).
The installed DSH Google adapter handles its native function calls; no custom
OpenAI base URL is used. A successful metadata request verifies access to the
model, while actual inference and tool behavior need their own recorded run.

## Register and change skills from code

The [bank pack](../examples/banking/support.config.json) contains eight procedures,
five published fact sheets and a versioned guard policy. Markdown sources live
under [skills](../examples/banking/skills). Use the existing importer from
`apps/api`:

```sh
npx tsx src/scripts/kb-import-skills.ts ../../examples/banking/skills eldhall-bank ../../examples/banking/support.config.json
npx tsx src/scripts/kb-import-skills.ts ../../examples/banking/skills eldhall-bank ../../examples/banking/support.config.json --write
```

Review the first command's output before writing. Increment the Markdown
`metadata.version` for a changed procedure or fact sheet. The resulting stable
IDs target the same stored records. Mount the generated JSON and restart the
API and workers to apply a newer revision. An older file does not overwrite a
newer operator edit; changed content under an identical revision is refused.

The operator interface edits stored skill text and enables or disables it using
its expected revision. A conflict keeps the draft for review rather than
replaying it. Changes affect the next model snapshot; a running turn cannot
commit using a revoked or changed enabled-skill inventory. Skills guide the
model and cannot grant backend permissions.

## Register and change guards

`guardPolicies` uses `{businessId, revision, guards}`. A named rule has a stable
UUID, `definitionVersion: 1`, `enabled`, `name`, `reason`, a registered action
`target`, and its typed rule fields. The bank pack includes:

- A refund stop rule (`deny_action`), initially disabled.
- A stricter refund ceiling of500UAH (`amount_limit`), initially enabled.
- Explicit operator approval (`require_approval`), initially enabled.

The code registry currently supports these three deterministic definitions.
Adding another executable definition requires backend code, schema validation
and tests. The UI configures registered rules; it never executes pasted
JavaScript or Python. External integration adapter guards retain their separate
reviewed manifest and server implementation.

Code updates increment `guardPolicies[].revision`. UI edits use the current
settings version and increment the stored guard revision. Stale changes fail
with a conflict. Disabling a custom rule cannot remove mandatory ownership,
duplicate-payment, full-amount, currency, execution-ledger or refund-approval
checks. A model confidence score cannot bypass any of them.

To compare behavior, keep server refunds allowed and change the refund skill to
require escalation without a refund proposal. Then restore the skill and enable
the refund stop guard: the backend must refuse a refund even if the model proposes
one. Also try enabling the stop guard after a pending proposal exists. Approval
and execution must use the current policy, not the proposal's old permission.

## Observe and evaluate

The shared ticket activity records the model identity, configuration and skill
revisions, tool attempts, safe input/result facts, server checks, final decision
rationale, failure and fallback provenance. A tool call is not proof of an effect;
only its application/provider result establishes the recorded outcome. Legacy
runs that only retained tool names are labeled accordingly. The operator view
uses concise decision explanations, not raw private chain-of-thought or native
session dumps.

[Scenarios](../examples/banking/scenarios.v1.json) define twelve acceptance cases,
including skill changes, confidence under a deny guard, a changed pending policy,
duplicate and non-duplicate payments, limits, published fees, unsupported card
and transfer operations, multiple goals, prompt injection and one-time simulated
execution. The criteria are not themselves passing results. Live results must
record the actual model, configuration revisions, tool observations and outcomes.
Use deterministic fixtures for ordinary CI; run paid inference only as an
explicitly authorized bounded evaluation.

[Sandbox records](../examples/banking/sandbox-data.v1.json) contain only synthetic
customers, public development persona tokens and synthetic captured payments.
They are example test inputs, not production onboarding credentials. Provisioning
must add only the designated bank records and preserve unrelated existing data;
never use a database-wide reset to switch the workspace.

The base sandbox has no card-freeze, transfer, account-balance, statement-generation
or email-sending integration. These cases should produce honest clarification or
handoff, with distinct tracked requests. A skill alone cannot create those tools.
