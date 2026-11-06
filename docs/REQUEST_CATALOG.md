# Customer requests inside one ticket

A ticket retains one shared conversation. Its request catalog tracks distinct
customer goals, not individual messages or tool calls. A request may have no
business action, several actions, or an action shared with another request.
Selecting a request changes the operator context pane; it does not create or
filter the customer conversation.

## Records and provenance

`CaseDetail.requestCatalog` contains a catalog version, synchronization state,
last processed source message, request records and bounded revision history.
Each request has a server UUID, a stable ticket-local number, a revision, title,
goal, tracking state, next step, message references, dependencies and links to
specific proposal revisions. The UI formats the number as a short request label;
it does not use a list index as identity.

The catalog is stored separately from `support_cases` and business tool arguments:

- `support_request_catalogs`: versioned request aggregate for one case.
- `support_request_checkpoints`: accepted source-message checkpoints for replay
  protection.
- `support_request_events`: append-only application revision/event snapshots.

Messages remain the original ticket messages. A request references their IDs;
manager annotations are not appended to customer-facing message bodies.
Persisted customer/model text keeps its original language when the operator
changes the UI language.

The current schema does not infer independent shipment, booking or other live
business records from a request description. Domain views may format explicit
proposal inputs and recorded results, or existing scoped payment records. A
stored execution response is dated evidence, not an automatic fresh read of an
external system.

## Agent checkpoints

The controlled agent records a bounded request checkpoint before business tool
dispatch or final submission. The harness and runtime enforce this ordering;
it is not only an instruction in a prompt. In particular, an `ask` operation
can end a model turn while waiting for approval without discarding the other
recorded requests.

The backend validates the current turn/ownership fence, catalog version,
request revisions, source messages and same-ticket references. Dependencies must
be acyclic. Retrying an accepted source-message checkpoint must not create a
second set of requests. The controlled model supplies an explicit existing request ID for an update.
The local fallback groups a bounded set of recognized request types heuristically;
matching titles alone does not establish semantic identity, so uncertain grouping
requires review.

The rules fallback is bounded and conservative. It can recognize supported
explicit request patterns; uncertain or unparsed content is marked for review.
It is not a claim that arbitrary business prose can always be split or deduplicated
correctly. Ordinary deterministic tests do not measure real-model extraction
quality, and do not contact paid model services.

Request tracking does not expand tool authorization or remove the bounded
one-external-action-per-turn behavior. Multiple recorded requests are not a
permission to dispatch multiple writes.

## Requests and actions have different lifecycles

Request lifecycle is `open`, `fulfilled` or `cancelled`, with a separate indication
of whether customer or staff input is needed. Proposal status remains the
existing approval/execution lifecycle. The UI can summarize a linked action that
needs approval, is executing or needs reconciliation; this does not make the
customer goal fulfilled.

Links are recorded atomically with proposal creation and pin the relevant
request revision. They are application metadata, outside `proposal.args`,
`argsHash` and upstream tool input. Material changes cannot transfer an old
approval to a new intent. Pending/approved proposals for a superseded request
revision are invalidated. Executing and unknown effects keep their original
ledger and reconciliation requirements; changing a request is not a retry path.

Operators use the authenticated endpoint:

```text
POST /api/v1/cases/:caseId/requests/:requestId/transition
```

The body supplies the expected catalog `version`, request `revision`, a
`transition` (`fulfill`, `cancel` or `reopen`), a human `reason`, and `proof`
containing proposal/message IDs. The backend validates scope, concurrency and
the evidence required for the transition. This endpoint does not execute a
business action. Marking a goal fulfilled is an explicit operator decision,
not an inference from an agent's success sentence. Message evidence must be a
later non-source customer or operator message; a customer's original request
cannot prove that it was fulfilled. Action evidence must be a successfully
executed proposal linked to the current request revision.

A tracked ticket cannot resolve while it has open requests, an out-of-date
catalog, or pending, approved, executing or uncertain effects. An explicit
resolution rejected by this check must not change ownership or queued work.
New customer input and reopened goals reopen the tracked ticket while retaining
its ownership. Existing tickets without tracked requests retain legacy behavior.

## Operator interface and updates

The right pane switches between the request list and the selected request's
goal, source messages, dependencies, actions, outcomes and history. The shared
message thread and reply draft remain mounted. Polling updates the catalog
without choosing a different request or resetting a manager's in-progress
review. Shared proposals have one guarded action-card instance, preserving
approval, rejection, busy and uncertain-execution state across views.

Existing cases may have proposals but no request catalog. They show an honest
unclassified/legacy view with their original actions still accessible. The
additive migration does not guess goals from historical prose, perform a paid
model replay, or delete the previous conversation. A subsequent controlled turn
can structure goals using validated source messages.

The new tables are introduced by
[`0009_customer_requests.sql`](../apps/api/migrations/0009_customer_requests.sql)
through the existing transactional migration runner. Review and back up an
existing installation before applying migrations. Schema observation includes
the exact new owned names and source identity; reviewed empirical fingerprints
must be regenerated from actual isolated PostgreSQL observations when these
inputs change. See [schema observation](SCHEMA_OBSERVATION.md).
