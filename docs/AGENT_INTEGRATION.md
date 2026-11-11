# Integrate the Eldhall support agent into your application

Use Eldhall behind your existing sign-in and chat UI. Your application authenticates the user and maps the account to an Eldhall customer. Eldhall stores conversations, runs the agent and sends requests that need a person to the operator inbox.

| Task | Start here |
| --- | --- |
| Send a message and display the reply | [HTTP quickstart](#make-your-first-request), [Python example](#use-the-python-example) |
| Build your own operator interface | [Operator workflow](#operate-a-conversation), [operator endpoint reference](API_CONTRACTS.md#operator-console--header-authorization-bearer-operator_token) |
| Give the agent access to policies, data or business tools | [Configure the agent](#configure-the-agent) |
| Look up a request body, response or status | [API reference](API_CONTRACTS.md) |

## Before you start

- Have a reachable Eldhall API and an operator credential. Use HTTPS outside loopback development. For deployment options, see [Build and run from source](../README.md#build-and-run-from-source).
- Identify your Eldhall business ID with `GET /api/v1/workspace` (configured workspace) or `GET /api/v1/businesses`, authenticated with the operator bearer. On an unbound installation, provision a new workspace through `POST /api/v1/businesses` if needed. Provision customer sessions for the resulting business ID.
- For an asynchronous deployment, run the API and its support worker. A successful `202` means Eldhall accepted the message; it does not mean a reply is ready.

Keep `OPERATOR_TOKEN` on your server. After your app verifies the signed-in user, resolve their Eldhall session from server-side storage. Verify that any case ID supplied by your browser belongs to that app user before forwarding a request. Treat both Eldhall credentials as secrets and keep them out of URLs, logs and analytics.

The typical request path is **browser → your authenticated backend → Eldhall API**. Use the operator bearer on provisioning and staff routes, and the customer's opaque `X-Customer-Session` on chat routes. A business ID scopes resources. See [workspace binding](API_CONTRACTS.md#fixed-workspace-editable-skills-guards-and-agent-activity) for deployment-level isolation.

Persist the mapping below in your application. Provision the customer once per business and app account. The provision endpoint creates a new identity on each successful request, even if the email is reused.

| Your record | Eldhall fields |
| --- | --- |
| App account in one business | `businessId`, `customer.id`, secret `sessionToken` |
| App conversation | `caseId`, linked to the owning app account |
| Outgoing message | `caseId`, exact message body, stable `clientMessageId` |

## Endpoints

Paths are relative to your Eldhall API origin.

| Method and path | Authentication | Purpose and successful response |
| --- | --- | --- |
| `POST /api/v1/customers` | `Authorization: Bearer <OPERATOR_TOKEN>` | Provision a customer. Send `{businessId,name,email,plan}`. Returns `201 {customer,sessionToken}`. Store the token against the authenticated app account. |
| `POST /api/v1/chat/cases` | `X-Customer-Session` | Open a conversation. No request body. Returns `201 {id,status,isTest:false}`. Save the ID and reuse it across turns. |
| `POST /api/v1/chat/cases/:id/messages` | `X-Customer-Session` | Send `{body,clientMessageId?}`. Use a nonblank body of at most 2,000 characters and a UUID per logical message. Worker mode returns `202 {caseId,status,ownership,reply:null,runId}`; inline mode returns `200 {caseId,status,ownership,reply}`. |
| `GET /api/v1/chat/cases/:id` | `X-Customer-Session` | Read `{id,status,ownership,businessName,messages,activeRun}`. The history belongs to the current customer only. |

## Make your first request

The examples use a POSIX shell, `curl` and `jq`. Set `ELDHALL_API_URL` (without a trailing slash), `ELDHALL_OPERATOR_TOKEN` and `ELDHALL_BUSINESS_ID` in your shell from private configuration. Use a development installation for this walkthrough.

```sh
set -eu

# Provision once per app account. In your app, store the returned token server-side.
CUSTOMER_SESSION=$(
  jq -n --arg business "$ELDHALL_BUSINESS_ID" \
    '{businessId:$business,name:"Example Customer",email:"support-demo@example.test",plan:"standard"}' |
  curl -fsS "$ELDHALL_API_URL/api/v1/customers" \
    -H "Authorization: Bearer $ELDHALL_OPERATOR_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @- |
  jq -er '.sessionToken'
)

# Open one case for the conversation.
CASE_ID=$(
  curl -fsS -X POST "$ELDHALL_API_URL/api/v1/chat/cases" \
    -H "X-Customer-Session: $CUSTOMER_SESSION" |
  jq -er '.id'
)

# Generate a fresh UUID for each new message; persist it before sending.
MESSAGE_ID=$(uuidgen)
jq -n --arg id "$MESSAGE_ID" \
  '{body:"My card was charged twice. Can you check?",clientMessageId:$id}' |
  curl -fsS "$ELDHALL_API_URL/api/v1/chat/cases/$CASE_ID/messages" \
    -H "X-Customer-Session: $CUSTOMER_SESSION" \
    -H 'Content-Type: application/json' --data-binary @-

# In worker mode, repeat the read until the run clears and render the new messages.
curl -fsS "$ELDHALL_API_URL/api/v1/chat/cases/$CASE_ID" \
  -H "X-Customer-Session: $CUSTOMER_SESSION" |
  jq '{status,ownership,activeRun,messages}'
```

The example also uses `uuidgen`. If unavailable, generate a UUID in your application runtime. Treat `messages` as authoritative and merge by message ID. This avoids displaying the same reply twice if you render it from the inline response as well. Render `body` as text or sanitize it if your UI supports rich text.

## Use the Python example

The [runnable example](../examples/support_chat.py) uses the Python 3.10+ standard library. Set `ELDHALL_API_URL` to the API origin and `ELDHALL_CUSTOMER_SESSION` to the development session provisioned above. Run from the repository root.

```sh
python examples/support_chat.py "I was charged twice. Could you check?"
```

The example prints the case ID and client message UUID to stderr, then writes the case history as JSON to stdout. It allows up to 130 seconds of socket inactivity for the send so it can handle inline mode. Worker-mode polling has a separate 45-second budget. The example leaves write retries to the caller. Treat the transcript output as customer data.

Use the printed case ID to continue the conversation or read its history.

```sh
python examples/support_chat.py --case-id "$CASE_ID" "Both charges were on the same day."
python examples/support_chat.py --case-id "$CASE_ID"
```

If the worker-mode message request timed out, use the original message ID and identical text.

```sh
python examples/support_chat.py --case-id "$CASE_ID" --message-id "$MESSAGE_ID" \
  "I was charged twice. Could you check?"
```

## Handle replies, handoff and retries

- **Agent response.** When `202` includes a non-null `runId`, poll the case while `activeRun.id` matches that ID. Start around every 2–3 seconds and back off during longer waits. When the run clears, render new messages and check the case status and ownership. A cleared run alone does not tell you whether the agent replied.
- **Operator response.** `ownership:"staff"` means a person owns the conversation. A staff-owned send can return a null reply and no run ID. Refresh history for the operator's reply. Display `awaiting_approval` as awaiting a decision. A substantive message can reopen a `resolved` case with tracked requests.
- **Worker retries.** On a transient or ambiguous send failure, replay the same case, body and `clientMessageId`. Eldhall trims the body before comparison. Reusing a stored ID with different content returns `409`. Send one logical message at a time per case. Matching text submitted under a second UUID while the same text is in flight can reuse the active run without storing the second UUID. Inline mode has no message deduplication. Serialize case creation on your server and reconcile ambiguous provisioning or creation results before issuing another request.
- **Rate limits.** Customer POSTs are limited to 60 per IP and 20 per supplied session per minute, per API process. A shared proxy can hit the IP limit first. Honor `Retry-After` on `429`.

See the [HTTP error reference](API_CONTRACTS.md#http-conventions-and-errors) for authentication, conflicts and other failures. The [message and run types](API_CONTRACTS.md#customer-channel--header-x-customer-session-token) define fields to render.

## Operate a conversation

Use the Eldhall inbox or call the operator API from your server with the operator bearer.

1. Read `GET /api/v1/cases/{caseId}`. The detail includes the case status and ownership, conversation, request catalog, proposals and activity. The agent replies in the conversation language and generates the staff-facing summary in the workspace language.
2. To take over, call `POST /api/v1/cases/{caseId}/takeover` with the current `ownershipVersion`. Takeover fences the agent's active turn and invalidates pending approvals.
3. Send a staff reply through `POST /api/v1/cases/{caseId}/messages` with `body` and the version returned by takeover. The customer sees it through the ordinary history endpoint.
4. When appropriate, call `POST /api/v1/cases/{caseId}/resume-bot` or `POST /api/v1/cases/{caseId}/resolve`. A case can only be resolved when its tracked requests and action effects no longer require attention.

```http
POST /api/v1/cases/{caseId}/takeover
Authorization: Bearer <operator-token>
Content-Type: application/json

{"ownershipVersion": 0}
```

Copy the actual version from the case detail. On `409`, reread the case and let the operator review its current state before retrying.

For a proposed action, show the exact stored arguments and policy checks. Send the proposal's `argsHash` to `POST /api/v1/proposals/{proposalId}/approve` to record consent. Execution is a separate call to `POST /api/v1/proposals/{proposalId}/execute` with the same hash. If execution returns `502`, inspect the returned proposal status and reconcile an unknown external result with the upstream before taking further action. See [approval and reconciliation](API_CONTRACTS.md#external-proposals-and-reconciliation) for the full rules.

## Configure the agent

| Business requirement | Integration path |
| --- | --- |
| Answer from policies, FAQs and product docs | Create a draft with `POST /api/v1/knowledge` and publish that revision with `POST /api/v1/knowledge/{id}/publish`. Customer retrieval uses published sources scoped to the business, audience and plan. See [knowledge base setup](KNOWLEDGE_BASE.md). |
| Give the agent a workflow | Create or draft a skill through `/api/v1/skills`, review it and enable it. Skills guide the agent's work within its current permissions. See [runtime configuration](integrations-runtime.md#documents-skills-and-guards). |
| Enforce a business rule | Use `GET` and `PUT /api/v1/guards`. The server validates typed rules and enforces them when proposing and executing supported actions. See [the guard reference](API_CONTRACTS.md#fixed-workspace-editable-skills-guards-and-agent-activity). |
| Read or change a record in your API | Connect an OpenAPI catalog, review operations and set Deny, Ask or Auto. Use Ask when a person must review the exact request before execution. See [OpenAPI integration](OPENAPI_QUICKSTART.md). |
| Read customer-specific facts from a database | Register a reviewed customer-scoped read-only source and configure its policy. See [database investigation](customer-database-investigation.md). |
| Use an existing knowledge index | Connect an approved external Qdrant source for read-only retrieval. See [external data sources](EXTERNAL_DATA.md). |

The business backend should enforce its own customer authorization and write invariants on every tool call. Configure the upstream customer and business mapping in trusted deployment settings. Treat identifiers supplied in chat or generated by the model as input, and validate them against the authenticated scope. Start with a read-only operation before enabling writes.

For example, create a customer-visible policy document for the selected business.

```http
POST /api/v1/knowledge?businessId={businessId}
Authorization: Bearer <operator-token>
Content-Type: application/json

{
  "title": "Delivery times",
  "category": "shipping",
  "content": "Standard orders ship within two business days.",
  "audience": "customer"
}
```

Review the returned draft. Publish it with `POST /api/v1/knowledge/{id}/publish?businessId={businessId}` and `{"version": 1}`, substituting the version returned by the draft. Then test retrieval with `GET /api/v1/knowledge/search?businessId={businessId}&q=delivery&audience=customer`.

A skill and a guard can cover the same workflow at different points. A skill can tell the agent what to verify before proposing an action. A guard can block that action or require approval. To enable a reviewed guard, read the current rule list and add the new rule or update its existing entry with `enabled:true`. Submit the full list and current settings version through `PUT /api/v1/guards`, which replaces the rule list.

## Test without polluting the inbox

Use Eldhall's built-in **Test chat** in a demo installation. It opens the conversation through `POST /api/v1/chat/test-cases`, which is available only when enabled on the server and accepts only configured demo identities. The case and agent trace remain inspectable in test history. Test chat activity does not appear in the ordinary inbox, action queue, team totals or analytics. Connected business tools and refund execution are disabled for those sessions.

Use the ordinary `/chat/cases` route when testing your own app integration against a development deployment. Such conversations appear in that deployment's inbox and reports, even when the customer and payments are synthetic. This verifies the same customer API your app will use in production.

Check `GET /health/ready` on the deployed API and confirm that the worker processes a synthetic customer turn. In development, `/docs` and `/openapi.json` help inspect routes. Use the [API reference](API_CONTRACTS.md) for the complete support request and response contracts.
