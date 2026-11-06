# Read-only schema observation foundation

This source-only module observes PostgreSQL 17 catalog state and evaluates an explicit reviewed reference registry. It is not wired into API/worker startup, migration execution, installation binding or a doctor CLI. Existing `DATABASE_URL` behavior is unchanged. No DB epoch, schema ledger or publisher-ready release manifest is inferred.

## Interfaces

`observeSchemaState({connectionString})` always creates and closes a fresh `pg.Client`. Its observer-only v1 input requires a complete PostgreSQL URL with explicit host, username, nonempty password and database. Missing port selects an explicit 5432. Only the documented TLS query options (`ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `sslnegotiation`) are accepted; duplicate parameters, fragments and routing/options overrides are refused. This narrow password-auth observer profile does not remove other connection modes from the application.

The driver receives explicit SSL fallback, readonly startup options, application name and bounded timeouts; its URL still controls explicit TLS behavior. Ambient `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGOPTIONS`, `PGSSLMODE` and related routing defaults cannot supply the selected connection. `process.env` is not modified. Credentials, endpoints, raw SQL and driver errors are excluded from results.

An autocommit catalog-only marker preflight is followed by a repeatable-read, read-only transaction. When the known ordinary marker exists, the observer locks only `public.alembic_version` before the first transaction SELECT and verifies its current qualified OID. It sets `row_security=off`, rejects unsafe marker shape/RLS/rules/inheritance and reads at most two rows with `FROM ONLY`. A replacement or newly appeared marker cannot be followed using stale metadata. OIDs are not emitted or fingerprinted. Lock/query/connect/idle timeouts and an overall deadline bound failures; an error yields `unobservable`, never empty state.

## What is observed

The reserved set is exactly `jobs`, `alembic_version`, the reviewed support table names through `0009_customer_requests.sql`, optional `support_knowledge_chunks`, and the zero-argument knowledge-history function/attached triggers. The `support_` prefix is not reserved: an unrelated `support_tickets` table is neither read nor claimed owned. Unmanaged public relations are reported only as a bounded count and do not change recognized owned fingerprints.

Fingerprints cover ordered visible columns, type/namespace/typmod, defaults, nullability, identity/generated and collation metadata; relation kind/persistence/RLS/inheritance/rule/policy state; constraint definitions/validation/deferral; index definitions, method, uniqueness and valid/ready/live state; attached trigger enablement/function binding and the reviewed history function's body/security/config properties. PostgreSQL hashes owned SQL definitions on the server, so raw definition/function text is not transferred. No unrelated function bodies or customer/payment/session rows are queried. Physical OIDs, file locations and statistics are excluded. This profile performs exact semantic-record matching, with no broad SQL rewriting or dump/restore equivalence claim.

Starter marker states, component absence/partial state and vector availability/installation/version/namespace are explicit. Vector unavailable, available-but-uninstalled and installed-with-chunks differ; installed vector with missing chunks is partial. Absence of owned objects does not establish whole-database emptiness or permission to initialize a shared business DB. Unsupported/unknown shapes lose recognition without repair.

An exact match covers only these selected records. The profile does not enumerate arbitrary inbound view/rewrite/dependency graphs or recognize future additive Eldhall objects, DB epochs or ownership compatibility. Extra tables can be unrelated business objects; their presence is not a prefix-based rejection rule. Later mutation requires a separately reviewed dependency, ledger and ownership policy.

## Registry and planning

`parseSchemaReferenceRegistry(text)` rejects oversized/deep/duplicate JSON, unknown fields, ambiguous entries and missing ordered SQL/runner hashes. A caller supplies a locally reviewed registry explicitly; there is no live enrollment or fabricated default reference. Empty entries mean no trusted match. Registry format `1` and observer profile `v1` are metadata formats, not DB epochs.

`matchSchemaReferences(observation, registry, sources)` requires an exact complete component/profile/fingerprint and matching current SQL plus runner hashes. `planSchemaAdmission(..., {starter, support})` requires both requested reference IDs to match. An exact current pair may report schema eligibility for API/worker with migration not required. Every plan is diagnostic-only and has `mutationAuthorized:false`. Unknown, partial, absent, source-drifted or mismatched states deny eligibility. The expected-before hash does not fence a future operation and is not a signed ownership proof.

No trusted PG fingerprint is invented in unit fixtures. Initial empirical output is a **private unreviewed candidate artifact** from the mandatory integration lane. Neither candidate generation nor the strict schema validator changes that trust status automatically.

The explicit [reviewed registry](../schemas/postgres-schema-references.v1.json) contains five entries derived after independent review of private CI run `41892940403`, integration job `126794828801`. Its [separate receipt](../schemas/postgres-schema-references.v1.receipt.json) binds the original candidate JSON SHA256, actual tested merge commit `2b346ae3584122572b72244ac1bea7feaf9dc9de`, observer-source hashes and declared fixture image inputs. All six schema integration tests passed without skips. The original candidate remains byte-exact and marked `unreviewed` in the private evidence archive; the reviewed registry is a separate derived artifact. Two starter entries reflect the distinct locale-sensitive plain/vector fixtures; the support entries cover unavailable, installed and available-uninstalled vector. These records do not claim portability to every PostgreSQL locale/version or establish DB epochs. A DB-free drift test checks current SQL/runner/observer bytes and reconstructs the original candidate hash. There is no default registry loader or runtime enforcement.

## Empirical fixture lane

Ordinary `npm test` remains DB-free. The explicit command from `apps/api` is:

```sh
node --import tsx --test tests/schema-state.integration.ts
```

This is a CI-only fixture, not a local arbitrary-target launcher. Before connecting, it requires `GITHUB_ACTIONS=true`, the fixture enable flag and source/run/attempt inputs identical to `GITHUB_SHA`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. It accepts only the declared service tuples: vector `127.0.0.1:5432`, user/database `app`/`app`; plain `127.0.0.1:5433`, user/database `app`/`schema_observer`; both require the declared synthetic fixture password. Missing or mismatched inputs fail before connection or DDL. There is no `DATABASE_URL` or ambient app-config fallback and no mutable generator CLI. The helper creates validated random **new** databases, runs the actual current migrators there and drops only databases it successfully created. Plain PG17 proves vector unavailable; pgvector PG17 supplies installed and restricted available-uninstalled cases. The restricted case grants schema creation to an existing nonsuperuser role only inside its new fixture DB, not by changing cluster roles.

Private candidate JSON records actual fingerprints, engine version, source/run identity, ordered migration/runner hashes, observer-source hashes and the fixed digest-pinned CI service image input per fixture. This last field identifies the declared CI input, not a driver-observed Docker image identity. It contains no connection strings, credentials, business rows or raw SQL; files are exclusive/private under `.omc/artifacts/schema-state`. The integration also exercises independent DB identity, idempotent migration, unrelated tables, real default/index/trigger drift and marker RLS/inheritance/replacement guards. No local Docker/PG success is claimed when that explicit lane has not actually run.

A future apply executor, privilege/ownership/sharing contract, verified epoch mapping, upgrade/restore policy and startup enforcement remain separate work. Such an executor must freshly inspect both components under the actual migration serialization protocol and commit migration/ledger changes atomically; current separately transactional migration helpers cannot be made atomic by blindly wrapping them.

Primary references: [node-postgres transactions](https://node-postgres.com/features/transactions), [client configuration](https://node-postgres.com/apis/client), [PG17 readonly transactions](https://www.postgresql.org/docs/17/sql-set-transaction.html), [PG17 binary hash functions](https://www.postgresql.org/docs/17/functions-binarystring.html).
