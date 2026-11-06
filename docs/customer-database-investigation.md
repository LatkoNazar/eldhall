# Customer-scoped database investigation

The support agent can inspect a PostgreSQL schema and write SELECT queries with
joins, filters, sorting and aggregates. It uses the existing business-tool gateway:
`describe_database` returns eligible tables, column types and database comments;
`query_database` returns typed rows and a query receipt. Reading does not approve or
execute a refund. Existing action permissions, guards and approvals still apply.

This is separate from Eldhall's own `DATABASE_URL`. A database URL used for support
persistence does not give the agent SQL access.

## Connect a database

Provision a dedicated login with SELECT privileges on the business columns that
support may read. Do not give it application-owner credentials, write permissions,
role membership, superuser or BYPASSRLS. Exclude passwords, session tokens, PINs
and similar secrets using column grants. An ownership relationship does not make
those fields suitable for a support agent.

Add a deployment-owned entry to the JSON file selected by `SUPPORT_CONFIG_FILE`:

```json
{
  "databaseSources": [{
    "id": "bank_records",
    "label": "Bank records",
    "businessId": "b1000000-0000-4000-8000-000000000001",
    "credentialEnv": "BANK_READ_DATABASE_URL",
    "schema": "bank",
    "ownership": {
      "customerColumn": "customer_id",
      "businessColumn": "business_id"
    }
  }]
}
```

Supply `BANK_READ_DATABASE_URL` to both backend and worker through deployment
secrets, for example a PostgreSQL URL for your read replica or existing server.
No extra database container is required. Never commit the URL or send it to the
model. Backend and worker each use a separate pool with at most two connections
per source; the support application's pool is not reused.

All ordinary tables in that schema with both ownership columns, supported scalar
types and readable columns are discovered automatically. There is no hardcoded
list of banking tables. PostgreSQL column comments become field descriptions;
add `COMMENT ON COLUMN` statements for business meanings and units.

By default, customer and business identifiers match Eldhall identifiers. If an
upstream system uses different identifiers, configure deployment-owned
`upstreamBusinessId` and `customerIdMap` (Eldhall customer UUID → upstream ID).
A configured map must contain the current customer: missing entries refuse access.
A customer-supplied account number is not identity.

For a different naming convention or a child table, add an explicit ownership
mapping. This example connects payments to the already scoped customer relation:

```json
{
  "relations": [
    {
      "table": "customers",
      "columns": ["id", "business_id", "name", "plan"],
      "ownership": {"kind": "columns", "customerColumn": "id", "businessColumn": "business_id"}
    },
    {
      "table": "payments",
      "ownership": {"kind": "parent", "parentTable": "customers", "foreignKey": "customer_id", "parentKey": "id"}
    }
  ]
}
```

The first version supports one direct parent, backed by a validated single-column
foreign key to a globally unique parent key. Matching column names alone do not
prove ownership. A table whose ownership cannot be established is unavailable.
Views, foreign tables, inheritance, tables with RLS/policies and unsupported
types are unavailable too. RLS policies can execute functions outside this SQL
profile; this version deliberately refuses them. The agent receives the eligible
schema, rather than guessing these relationships.

The initial discovery budget is 64 relations per schema and up to 40 selected
scalar columns per relation. Expression indexes, partial indexes and custom
operator classes are refused in this profile because planning or scanning them
can execute code outside the permitted SQL functions. Ordinary indexes remain
available; index the ownership columns for efficient scoped reads. These are
explicit connector limits, not a claim that every PostgreSQL schema is supported.

## Enable and limit access

Open **Guards → Database investigation**. A configured source is shown separately
from runtime connectivity: configuration alone is not a successful database check.
Access starts disabled. Enable it and save the limits. Backend checks the current
settings version before and after each call; changing access invalidates a running
turn. Concurrent edits use the same compare-and-swap version as other settings.

The identity boundary and read-only mode cannot be disabled in the UI, a skill,
customer text or a SQL query. Defaults:

| Limit | Default | Allowed range |
| --- | ---: | ---: |
| Calls per turn | 8 | 1–12 |
| Query deadline | 2,000 ms | 100–5,000 ms |
| Returned rows | 100 | 1–200 |
| Response bytes | 32,768 | 1,024–65,536 |

Prefer aggregates when checking totals and duplicates. The row limit applies to
the returned result, not to source rows before an aggregate. A truncated result
is explicitly marked and must not be described as a complete history.

## Enforcement and audit

The server parses a restricted SQL profile and compiles a new query; original SQL
is never executed directly. Each referenced relation becomes a server-owned
`MATERIALIZED` CTE filtered by the authenticated customer and business. Omitting
`WHERE`, adding `OR true` or joining another table cannot remove that boundary.
Identifiers, functions, operators and types are checked; unsupported SQL fails
closed. This is intentionally a smaller SQL profile than arbitrary PostgreSQL:
model-written CTEs, commands, user functions, system catalogs and role/session
changes are not available.

The dedicated connection executes in a read-only transaction with server
deadlines, resource bounds and bounded output. Ownership and relation metadata
are checked under locks. These checks complement the database role's privileges;
they do not replace the responsibility to provision a safe reader.

The activity journal records source, query receipt/hash, outcome, timing, row count,
truncation and guard checks. It does not store raw SQL literals, returned business
rows, credentials or private chain-of-thought in general activity logs. The model
gets the returned facts and can provide a brief evidence-based explanation.
