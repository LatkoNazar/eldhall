# Runtime configuration and business MCP tools

The API runs headless. React is an optional operator and customer client. Set `SUPPORT_CONFIG_FILE` to an operator-controlled JSON file to mount businesses, ticket classes, reviewed documents, prose skills, and MCP read tools without rebuilding the image. The default is an empty configuration and makes no external MCP connections. JSON is the only supported config format in this MVP.

Copy `examples/support.config.json`, replace the sample MCP URL with your server, and provide `ORDERS_MCP_TOKEN` through the API environment. The example creates a new business; it contains no customers or session credentials. Provision customer sessions through the authenticated operator API. For a docs-only deployment, remove the `integrations` entry and its unused credential variable. A file with no integrations needs no MCP credentials.

From `apps/api`, a local launch can use `SUPPORT_CONFIG_FILE=../../examples/support.config.json` (use the equivalent environment-variable syntax in your shell). A container can receive the same file through a read-only bind mount, with `SUPPORT_CONFIG_FILE=/config/support.config.json`. Keep tokens in your existing secret/environment setup. Configuration accepts environment-variable names, never inline token values or arbitrary HTTP headers. It is not returned by the public capabilities API.

## Documents, skills, and guards

Configuration loads at API startup; restart the process after changing the mounted file. Zod validates unknown fields, UUIDs, sizes, schema shapes, unique identifiers, and MCP URL policy. An invalid or missing configured file stops startup. All document, skill, and integration business references must already exist in the store or appear in `businesses`.

Business rows bootstrap initial deterministic guards through `policy`: enabled actions, refund limit, and duplicate-charge window. Existing business policy remains controlled by the persisted operator settings. File bootstrap does not reset those settings. Refunds continue to require separate human approval and explicit backend execution; external writes are not supported by this integration adapter.

Documents have a `version`, publication status, category, title, and prose content. Only published documents are supplied to the agent's business-scoped lexical search. Skills have a `revision`, enabled flag, name, and reviewed prose content. They guide the model but cannot grant permissions or add executable code. Neither file contents nor runtime skills can load scripts, filesystem tools, shell commands, arbitrary plugins, or MCP endpoints.

On restart, identical document versions and skill revisions are left intact. A higher configured version/revision updates the stored row. A lower revision does not overwrite a newer operator edit. Changed content under the same revision, or reusing an identifier from another business, stops startup. Increment the revision when intentionally updating a mounted document or skill. Startup validates references, slug conflicts, and revisions before writing. Bootstrap is idempotent per resource, rather than one transaction across the whole file: an unexpected database failure can leave earlier rows applied. Fix the failure and restart to finish the import.

## Business ticket classification

Add a `classifications` entry for each business. IDs are stable strings: `"1"` through `"5"` and `"other"` are supported, as are meaningful identifiers such as `"billing"`. Labels, descriptions, and examples describe that business's taxonomy. By default the existing support agent decision also returns the class, using Gemini or the configured compatible conversation model. An optional dedicated OpenRouter Decisions classifier can classify separately while DSH/Gemini continues to handle replies and tools.

```json
{
  "classifications": [{
    "businessId": "10000000-0000-4000-8000-000000000001",
    "revision": 1,
    "fallbackClassId": "other",
    "minimumConfidence": 0.6,
    "classes": [
      { "id": "1", "label": "Оплата", "description": "Рахунки та списання.", "examples": ["З мене списали двічі."] },
      { "id": "other", "label": "Інше", "description": "Інші або незрозумілі запити.", "examples": [] }
    ]
  }]
}
```

The complete [example configuration](../examples/support.config.json) contains five custom classes plus `other`. Each taxonomy requires 2–50 unique IDs, a configured fallback ID, a positive revision, and a finite threshold from 0 to 1. IDs use 1–64 ASCII letters/digits plus `_ . : -`; labels are at most 100 characters, descriptions 500, and each class has at most five 200-character examples. The normalized taxonomy also has a bounded 16,000-character context budget.

The backend validates the result against the authenticated business's classes and stores `analysis.classification`: `classId`, server-owned `label`, `confidence`, short factual `reason`, taxonomy `revision`, `needsReview`, `source`, `reasonCode`, and optional classifier `provider`/`model` provenance. This is a single best class, not multiple labels. Low confidence selects the fallback class and marks review required. Missing, malformed, or unknown classes also fall back for review; provider/rules fallback does not fabricate a custom category. For embedded agent classification, confidence is self-reported by the model. The dedicated Decisions adapter uses the provider's returned choice probability. Neither score is a measured or calibrated accuracy guarantee; evaluate thresholds with representative business tickets. Classification provenance/fallback is independent of the conversation model's status.

Classifiers are persisted in settings. Identical revisions are idempotent; higher revisions replace only the classifier and preserve current language, tool permissions, refund limits, and approval requirements. Lower revisions are ignored, and changed content at the same revision stops startup before import writes. Concurrent settings changes produce a version conflict rather than being overwritten. Restart both API and worker after changing the file. Removing the entry leaves the stored classifier intact. An authenticated settings PATCH with `classification: null` disables it and retains the last taxonomy revision internally. Stale or equal-revision mounted entries cannot re-enable it after restart; re-enabling requires a valid taxonomy with a higher revision. The disabled watermark is not returned as classifier configuration. A business that has never had a taxonomy can still load its first valid revision after unrelated settings edits.

Historical cases retain the label and revision used for their analysis. A taxonomy change during an active model run fences that result; a later customer turn uses the current taxonomy. Existing cases are not automatically reclassified. Classification guides operator triage and never grants permissions, selects a payment tool, changes deterministic policy, or replaces the internal safety-related `intent`.

`scoreKind` optionally identifies `model_self_report` versus `selected_probability`. When a known candidate falls below the threshold, the final class becomes the fallback and `proposedClassId`/`proposedLabel` preserve the server-validated candidate. The score still refers to that candidate; it is not the probability of the fallback class. The operator UI displays the candidate separately to keep this distinction clear.

## MCP protocol and trust boundary

The adapter uses the official `@modelcontextprotocol/client` 2.3.0 SDK, pinned in the API package and lockfile, with Streamable HTTP: initialize, list tools, call the configured tool, close. Each call opens a short-lived connection. It never loads server instructions into the model. The DSH process sees only the fixed `call_business_tool` facade and reviewed metadata; the parent API retains URLs, credentials, and the actual MCP connection.

Every configured tool requires `access: "read"`. Its identifier and input schema are allowlisted for one business. The model chooses only among those advertised tool identifiers, and cannot choose an endpoint, header, or credential. The runtime and adapter validate the allowlist again at invocation. Server tool discovery must contain the configured name; an advertised destructive tool or explicit `readOnlyHint: false` is rejected. These annotations are a consistency check, not proof of safety: configure only reviewed read operations and use upstream credentials with read-only privileges.

`scopeBindings` names two upstream argument fields. The API supplies their values from the authenticated customer's business and the active conversation lease. Those fields must be distinct and absent from the model input schema. A call that supplies either field is rejected, even if its value matches the session. The active lease is rechecked before the remote call and after receiving its result, so staff takeover prevents that result from reaching the agent.

**The upstream MCP server must enforce both business and customer ownership for every queried object.** The injected identifiers express scope; they do not prove that a third-party server implements row-level authorization. An `order_id` must be checked against both scope fields upstream. The adapter cannot verify an upstream server's ownership enforcement or make a write implementation read-only.

Input schemas support a bounded JSON Schema subset: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, `enum`, `required`, numeric bounds, `maxLength`, and `maxItems`. Every object must set `additionalProperties: false`. References, remote schemas, patterns, and executable validators are rejected. Nesting is at most five levels; inputs are at most 16 KiB, strings 4000 characters, and arrays 50 entries. Smaller configured limits are enforced.

Upstream output must be `structuredContent` with a flat JSON object, or one JSON text block containing a flat object or array of flat objects. `outputFields` projects only approved top-level scalar fields and scalar arrays; nested objects and unlisted fields are removed. This intentionally excludes arbitrary rich content, embedded resources, raw server errors, and metadata. At most 50 output records are accepted. The configurable output limit is at most 32 KiB, and the raw transport response limit is 128 KiB.

URLs require HTTPS without user info, query strings, or fragments. Redirects and requests to other targets are denied, including auth discovery. For a local development/test server only, `allowInsecureLoopback: true` permits HTTP at `127.0.0.1`, `localhost`, or `[::1]`; it does not allow HTTP to other hosts. The model cannot set this flag. A per-call deadline (default 5 seconds, maximum 30 seconds) covers connection, discovery, and invocation. The active run's cancellation signal also cancels network requests. Missing credential references fail startup; upstream errors become a generic unavailable result without exposing response bodies or tokens.

See the [official MCP client connection guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect) for the installed SDK's handshake and transport behavior. This adapter deliberately supports configured read tools only; it is not a general MCP proxy or an external-write executor.
