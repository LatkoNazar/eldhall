# Structured inspector templates and local examples

The inspector uses presentation templates for known business processes in both
Inbox and Actions. Templates only select and format fields already present in a
case/proposal. They do not add a connector, business rule, permission, database
schema, model tool, approval or execution capability.

## Select a template

External proposals use an exact reviewed OpenAPI operation tag, carried into the
existing proposal snapshot as `args.tags`:

| Tag | Purpose | Allowed domain fields (snake_case; equivalent camelCase aliases are supported) |
| --- | --- | --- |
| `eldhall.ui.payments` | Payment request | `payment_id`, `transaction_id`, `amount_cents`, `currency`, `status` |
| `eldhall.ui.delivery` | Shipment or delivery change | `shipment_id`, `tracking_number`, `carrier`, `delivery_date`, `status` |
| `eldhall.ui.orders` | Order change | `order_id`, `order_number`, `item_count`, `status` |
| `eldhall.ui.returns` | Return request | `return_id`, `order_id`, `reason`, `status` |
| `eldhall.ui.booking` | Stay or reservation | `booking_id`, `starts_at`, `ends_at`, `guest_count`, `status` |
| `eldhall.ui.appointments` | Service appointment | `appointment_id`, `service_name`, `starts_at`, `specialist`, `status` |
| `eldhall.ui.subscription` | Subscription change | `subscription_id`, `plan_name`, `effective_at`, `status` |
| `eldhall.ui.account` | Account/profile change | `account_id`, `contact_email`, `requested_change`, `status` |
| `eldhall.ui.access` | Access request | `user_id`, `resource_id`, `role`, `expires_at`, `status` |
| `eldhall.ui.incident` | Service incident | `incident_id`, `service_name`, `severity`, `impact`, `status` |
| `eldhall.ui.warranty` | Warranty claim | `claim_id`, `product_id`, `serial_number`, `issue`, `status` |
| `eldhall.ui.escalation` | Handoff to a specialist | `ticket_id`, `team`, `reason`, `priority`, `status` |

The registry uses one recognized UI tag, never the integration name, operation
title or guessed industry. Ordinary OpenAPI tags outside `eldhall.ui.*` are
ignored. Unknown UI tags, malformed tag arrays, or multiple distinct UI tags fall
back to the generic inspector. Existing native `refund_payment` and
`escalate_to_human` tools have their known presentation paths. An alias is only an
equivalent spelling; conflicting snake/camel values are omitted with a warning.

Put the tag on the actual OpenAPI operation using its existing `tags` array:

```yaml
paths:
  /shipments/{shipmentId}/reschedule:
    post:
      operationId: rescheduleShipment
      tags: [eldhall.ui.delivery]
```

This is an excerpt of an upstream API description, not a new Eldhall config key.
Use the existing [OpenAPI catalog workflow](OPENAPI_QUICKSTART.md) and
[manifest review contract](integrations-manifest.md). Changing operation metadata
changes the reviewed manifest/operation identity; existing review, activation,
permission, scope and execution checks still apply. A presentation tag never
makes an operation executable.

## Requested versus recorded data

- `proposal.args.input` is the requested input, including pending or approved
  changes. Approval alone does not confirm a result.
- Only an `executed` proposal's flat object `proposal.result.data` supplies a
  recorded execution result. `unknown`, failed and other non-executed states do
  not become success facts. An unknown external effect requires reconciliation;
  it must not be retried automatically.
- Financial context comes from actual matching `CaseDetail.payments` records.
  Money requires amount and currency from the same source object; currency must
  not be guessed from another case or unrelated result.
- These views do not invent executed read proposals or stored MCP read
  observations: the current case DTO does not expose such observations.
- Customer names/messages, operation IDs, source records and API values retain
  their original content. No arbitrary HTML or external URL is interpreted as
  template markup.

To add a template, extend the reviewed frontend registry with a new exact tag,
explicit primitive field allowlist, safe formatters and all five UI translations.
Add tests for pending/approved input, executed result, missing/invalid/conflicting
fields, unknown outcomes and generic fallback. Keep the same pure presentation
model in Inbox and Actions. The current set has twelve built-in template IDs;
editing a demo JSON file does not install a thirteenth runtime template.

## Diverse synthetic examples

[scenarios.v1.json](../examples/inspector/scenarios.v1.json) has `fixtureFormat: 1`
and thirteen independent fictional businesses/customers: twelve tagged domains
and one generic fallback. Examples include a course charge, book delivery,
ceramic order, jacket return, guest stay, bicycle service appointment, workspace
subscription, profile email, temporary archive access, service incident,
coffee-grinder warranty and travel escalation. They include pending, approved,
executed, unknown, failed, expired, rejected and invalidated states.

Every case/customer/business/proposal scope is internally consistent. Addresses
use `example.invalid`; names and records are fictional. Only the payments example
has payment records. No example contains real credentials, live provider data,
executed model runs or hidden database seeds. The executed examples contain
**authored synthetic historical results**, not proof that an integration ran.
Snapshot hash-shaped fields are fixture identities, not real catalog-review or
provider receipts. `argsHash` follows the current scoped algorithm: SHA-256 of the JSON array
`[caseId, tool, canonical(args)]`, with recursively sorted object keys.

Run the isolated preview from the repository root:

```sh
npm --prefix apps/frontend run demo:inspector
```

The launcher serves the frontend on `http://127.0.0.1:5192` and the fixture API on
`http://127.0.0.1:5293`. Open `/operator`; use the public local-demo key `1111`.
Select a case from the queue or an action from the appropriate current/history
tab. The frontend's inspector-demo banner identifies the data as synthetic and
its case, action and chat mutation controls are disabled. Other editor controls
may remain visible, but every API write is rejected with 405. Stop the one launcher process to
close its owned servers. Marketing pages are not part of this preview.

The API can also be run alone:

```sh
node scripts/inspector-demo.mjs
# Or an OS-assigned loopback port for an isolated test:
node scripts/inspector-demo.mjs --port 0
```

The standalone script prints only its local URL and presentation/read-only mode.
It reads only the checked-in fixture, never `.env` or production configuration.
`HOST`, `PORT`, `OPERATOR_TOKEN`, database URLs, provider settings and analytics
settings from the environment cannot change its listener, token or behavior.
It does not launch a browser. Importing the module never opens a port;
`createInspectorDemoServer()` returns an unbound native HTTP server and
`startInspectorDemo({port})` returns a listening native server owned by the caller.

GET console endpoints return fixed snapshots and derived counts. Optional
`businessId` filtering scopes cases/details/metrics to that demo business;
unknown or conflicting scope does not fall back to another business. All writes
return **405**, including approval, execution, rejection, reconciliation, message
send, takeover, settings changes and reset. The server never calls a model,
MCP adapter, payment provider, real database or real API. The key `1111` exists
only in this loopback synthetic fixture service; production authentication is
unchanged. No production service is started or modified by these commands.

On startup the server shifts protocol timestamps relative to the fixture clock
once, giving pending snapshots a thirty-minute demo expiry, and recomputes their
fixture argument hashes. Domain dates requested by customers remain their
original synthetic values. Requests never advance state or regenerate outcomes.
Restarting resets only this in-memory presentation snapshot; it does not reset a
development or production database.

Verify the fixture/server contract without external services:

```sh
node --test scripts/tests/inspector-demo.test.mjs
```

This is private presentation/test preparation. It is not a deployment recipe,
a twelve-connector implementation, a source/image publication or production
permission grant.
