# Existing company data sources

The support service can use data already hosted by the company. Hosting location is independent of the database protocol: an address must be reachable from the API and worker, with the appropriate TLS, credentials and connector.

| Purpose | Supported connection | Writes |
| --- | --- | --- |
| Support conversations, jobs, approvals and audit | PostgreSQL `DATABASE_URL`, local or remote | Support migrations and operational records |
| Existing centralized knowledge | Qdrant URL + collection + embedding/payload configuration | None to Qdrant; only citation metadata in support storage |
| Customers, orders and other business records | Reviewed MCP tools in `integrations` | Read-only gateway in this release |

`DATABASE_URL` is not a universal database adapter. MySQL, SQL Server, MongoDB and other business systems can be exposed through a compatible MCP server; native drivers for those engines are not implemented as support storage. A business database used through MCP does not receive support migrations. See [MCP configuration](integrations-runtime.md) and [external PostgreSQL deployment](implementation.md).

## Connect an existing Qdrant collection

Use [the complete example](../examples/support.qdrant.config.json) as your `SUPPORT_CONFIG_FILE`, or add its `externalKnowledge` entry to the existing config. Use your existing business ID. API and worker need the same config and credentials.

```dotenv
SUPPORT_CONFIG_FILE=/etc/support/support.config.json
QDRANT_API_KEY=your-read-only-collection-key
GEMINI_API_KEY=your-embedding-provider-key
```

The example is illustrative. Replace the URL, collection, vector name, payload paths, tenant and **embedding model/dimensions with those used by your existing collection**. Having the same vector size does not make two embedding models compatible. The normal local KB hashing embedder is never used implicitly for external Qdrant.

Configuration supports:

- `embedding.provider`: `google`, `openai`, or `local` (an OpenAI-compatible embedding endpoint, not necessarily on the same machine). Model and dimensions are explicit. Local endpoints also need `baseUrl`, e.g. `https://embeddings.company.example/v1`.
- `vectorName`: required for a named dense vector; omit for an unnamed vector. Dense single-vector collections are supported; sparse/multivector retrieval requires another adapter.
- `fields`: text, title, section and optional version paths, including nested paths such as `metadata.title`.
- `access.tenant`: a fixed company filter bound to the configured business, never supplied by the model. A dedicated tenant collection can explicitly set `singleTenant: true` instead.
- `access.published` and `access.customerVisible`: required visibility conditions. Only an entirely reviewed public collection may explicitly set `trustedPublicCollection: true` instead.
- `access.planField`: optional plan filter. The service injects the customer's plan; `publicPlanValue`, e.g. `all`, identifies universally accessible points. Without a public marker only the matching plan is allowed.
- `credentialEnv`: names a server environment variable. No secret values belong in JSON, browser bundles or URLs. Standard Compose passes `QDRANT_API_KEY`, `KB_EXTERNAL_EMBEDDING_API_KEY` and existing provider keys; custom variable names must be explicitly passed into both API and worker containers.

HTTPS is supported for public and private network endpoints. The explicit `allowInsecureLoopback` option permits HTTP only on localhost for local development. For remote self-hosted Qdrant, provide HTTPS through your private ingress/reverse proxy. Redirects are refused.

The connector inspects the collection's vector size/name, embeds each query using the configured model, applies access filters and retrieves a bounded set of passages. It does not create a collection, upload documents, change indexes or copy the corpus into local knowledge tables. Existing points must contain readable text in the mapped payload field. Collection schema inspection checks dimensions but cannot discover which model originally produced vectors.

For a configured business, external retrieval replaces the local KB search. Local articles remain editable as separate content, but are not automatically written to or searched alongside Qdrant. The operator search panel shows the external collection and disables reindexing. It always uses customer visibility, including when an operator asks the question.

## Source changes and outages

The support database retains references and content hashes for external facts used in replies. Returned points are checked again for content and access changes before completing a turn and before including those replies in customer/model history. Follow-up turns retain dependencies on earlier verified facts. The native agent session is fresh per external-KB turn so hidden old retrieval results cannot bypass these checks.

This is last-read validation across two services, not a distributed transaction with Qdrant. Changes after validation cannot be locked atomically with the support commit. Use controlled publishing in the source system. Missing/changed/unavailable sources are handled conservatively; the application does not silently substitute an unrelated local knowledge base.

Knowledge-gap Insights currently analyze local published sources only and omit external-derived replies whose citations they cannot validate. They do not claim to audit the entire remote collection.

## Ordinary business databases

Use a database-specific MCP service or a small adapter around your existing backend. Configure reviewed operations such as `lookup_order`, not arbitrary model-generated SQL. The support gateway injects business/customer identity, limits arguments and output fields, and only enables declared read tools. The adapter enforces the same scope and uses a database account with only the permissions it needs.

The same support-side MCP configuration works whether the adapter uses managed PostgreSQL, MySQL, MongoDB, a private datacenter, or an internal HTTP service. The database protocol is implemented by that adapter. Changing the protocol requires a matching adapter, not merely another connection URL.

Qdrant protocol references: [query points](https://api.qdrant.tech/api-reference/search/query-points), [retrieve points](https://api.qdrant.tech/api-reference/points/get-points).
