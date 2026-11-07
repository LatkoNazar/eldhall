# Provider-neutral agent context

The support agent builds a bounded view of current application records. This protocol does not require a provider prompt cache, a model-written conversation summary, or a new memory table. Skills remain instructions; backend permissions, ownership checks and guards remain authoritative.

The work follows the requested order **4 → 5 → 2 → 1**:

| Stage | Behavior |
| --- | --- |
| 4 — skills and tool details on demand | Supply mandatory instructions and a short catalog; load relevant instruction bodies and exact schemas by their advertised IDs. |
| 5 — process work | Keep checkpointing and independent context reads eligible for one native model step. Batch only eligible independent business reads; stop at an operator-approval boundary. |
| 2 — history deduplication | Supply the current customer message once in the memory projection; select recent history and retain uncheckpointed customer messages. |
| 1 — structured ticket memory | Project current request revisions, dependencies and recorded action states from the existing store. |

There is no phase-3 LLM compaction call and no provider-specific caching dependency. Fewer initial bytes do not by themselves establish fewer provider calls or lower latency.

## Skill activation

An enabled skill is always supplied unless its **stored content** starts with a recognized activation header. For an on-demand skill:

```markdown
---
activation: on_demand
description: Use for duplicate card-payment investigations and refund requests.
---
# Refund procedure
Use scoped evidence and current server policy. Never infer successful execution.
```

Use a single inline `activation` and a single inline `description` containing 1–240 characters. `activation: always` is also recognized. Missing, duplicate, unknown or malformed activation metadata remains always supplied; it cannot silently hide the procedure. This is a small metadata profile, not a general YAML evaluator.

The [pack importer](../apps/api/src/modules/knowledge/skill-md.ts) preserves recognized activation metadata in the stored content. Legacy packs without this metadata retain their existing output. Explicit metadata that would exceed the stored content limit is rejected instead of truncating additional instructions. Changing content or activation requires a higher skill revision; the stable skill ID does not change. An older file revision cannot overwrite a newer stored edit.

The [banking example](../examples/banking/support.config.json) contains eight code-first skills. Evidence, security and request workflow remain mandatory. Card support, complaints, fees/statements, refunds and transfers opt into on-demand loading at revision 2. A deployment may contain additional custom skills; they are not automatically rewritten or made optional by importing this example.

The Skills editor accepts the same content header. Its enabled switch and versioned save behavior are unchanged. Activation does not install an integration, enable an action or bypass an approval.

## Catalog and exact detail loading

`load_support_context` accepts advertised identifiers:

```json
{
  "skillIds": ["advertised-skill-id"],
  "toolRefs": [{ "integrationId": "advertised-integration", "name": "advertised-tool" }],
  "messageIds": ["known-older-message-id"]
}
```

It accepts no URL, filesystem path, credential, customer selector or SQL connection. Each request may select up to four skills, four tool schemas and eight messages. The complete selection must resolve within the current run; a foreign or unavailable ID fails the request rather than returning a partial selection. The serialized detail response is bounded to 65,536 bytes, with active-policy checks before and after resolution.

The initial catalog contains skill purposes and activation modes, plus business-tool descriptions and argument names. Full optional instruction bodies and full business-tool schemas are loaded separately. Fixed support tools and mandatory instructions still apply. Loading a schema is not authorization to call its operation.

Only business reads explicitly advertised as `batchRead: true` are eligible for `call_business_tools`. Current policy, scope, checkpoint and budget checks still apply to every member. An ask/write action is not an independent read batch, and approval remains separate from execution.

## Memory, history and sessions

The [memory projection](../apps/api/src/modules/agent/context-memory.ts) uses existing messages, the request catalog and proposal/execution records. It includes:

- the current customer message and selected recent messages;
- current request IDs, revisions, goals, dependencies and explicit action links;
- pending, approved, executing and unknown action states;
- executed-action receipts, without promoting them to fresh external facts;
- coverage information identifying uncheckpointed messages and the availability of older history.

Conflicting duplicate message IDs fail validation. Uncheckpointed customer messages remain represented even when they fall outside the usual recent-message window. A required-state projection exceeding 131,072 bytes fails explicitly; it is not silently summarized or truncated.

If constructing required memory raises `SupportContextError`, the application calls neither the primary model, fallback model nor separate classifier. It preserves existing requests and actions. Only an unaccepted source receives an explicit empty-change `needs_review` checkpoint; an already accepted source keeps its checkpoint. The application records a `context-guard` handoff through the normal guarded completion path. Its `fallback` status describes an application handoff, not a fallback-model request, and grants no business-action permission.

For a context-aware native run, the runtime derives a fresh session identity from the current turn/run/attempt and uses this memory instead of replaying a previous conversation transcript. The native harness and capability gateway are closed when that decision attempt ends. This is not a persistent global model-process cache.

The model explicitly opts into `contextProtocol: 'catalog-v1'`. Callers without the protocol retain the legacy path with eager instructions and schemas; the new optional fields do not silently change existing scripted-model behavior. Current application records, skill inventory/revisions, settings, integration permissions and ownership are still rechecked before completing a turn.

## Operator evidence

Agent Activity separates the **available skill catalog** from the **instruction bodies supplied at the start of the turn**. Catalog entries contain only ID, name, revision, purpose and activation. They do not establish that an optional body was loaded. Later tool-result records report actual context loads with their identifiers, hashes and character counts. Legacy activity without this catalog remains readable.

These records expose operational decisions and evidence, not hidden chain-of-thought. Neither stored history nor a prior successful action grants permission for a later operation.

## Deterministic measurements

Run the focused, provider-free measurements from `apps/api`:

```sh
node --import tsx --test tests/skill-activation-import.test.ts tests/banking-pack.test.ts tests/context-footprint.test.ts
```

The footprint fixture holds the same eight public banking instruction bodies constant. It compares eager skill JSON against mandatory bodies plus the real catalog, then calls the actual context loader for one-domain and multiple-domain selections. Diagnostics report UTF-8 bytes, JavaScript UTF-16 character counts and actual loaded reply bytes. Catalog overhead and loaded replies are included in their respective totals. A multiple-domain turn can lose the initial-byte saving once details are loaded.

This fixture excludes the private custom ninth skill, fixed system policy, tool-envelope overhead and full model-request history. It makes no provider token, cost, latency or quality claim and performs zero native model calls. Runtime endpoint tests separately capture actual native request messages/tools and count generation requests. Tool-call counts and SDK step counts must not be reported as provider-request counts. Paid model evaluation requires its own approved run and retained evidence.
