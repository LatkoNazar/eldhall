# Source-preview release status

Updated 4 November 2026. This guide describes the product source and the boundaries a source recipient must retain. It is not an announcement of a public source repository, downloadable release or supported production service. Publication remains a separate explicit owner action.

## Implemented and exercised

The API/worker use durable PostgreSQL jobs, fenced leases and recorded action outcomes. Reviewed OpenAPI catalogs have authenticated fixed-target MCP dispatch, DB-backed `auto / ask / deny` policy, explicit review/activation, separate approval/execution, expiry, invalidation and unknown-effect reconciliation. The [architecture](ARCHITECTURE.md) and [API contract](API_CONTRACTS.md) describe these application guarantees and their limits.

The locally built server image includes [help/version/static validation](CLI.md) and [Linux offline init](INSTALLATION_INIT.md). Init creates private files and a stable versioned identity with state `prepared` and release binding `unbound`. It does not start containers, discover a database/schema epoch, establish storage ownership or verify a model/provider. Partial/conflicting state is refused without overwrite.

Native AMD64 and ARM64 candidate checks have exercised server/web/MCP source builds, architecture/non-root/notices, CLI build identity, actual-image init/privacy/replay and the synthetic DSH/MCP/worker/UI flow. Candidate builds also rebuild the three product images from a verified exact-commit source archive. Separate Linux tests verify the actual Compose parser and literal values received by a running Compose service. These are source-build checks, not registry pulls or a clean-host installation report. Rerun them for the exact candidate; earlier results do not certify later source or build inputs. Reports collected during private preparation do not imply publicly retrievable evidence.

Product-authored software has [Apache-2.0 and NOTICE](LICENSING.md), package SPDX metadata, project-scoped image labels, shipped browser notices and drift validation. Dependencies and services retain their own terms. [Native review inputs](NATIVE_RECEIPTS.md) are bounded installed-file fingerprints/notices; they are not complete SBOMs or verified corresponding-source availability.

## Installation and publication still open

The selected public Docker Hub repositories are `latkonazar/eldhall-server`, `latkonazar/eldhall-web` and `latkonazar/eldhall-mcp-openapi`. They contain no published product images at this checkpoint. No image tag, signed release manifest or pull-only install bundle is supplied by this source preview. A repository name or a locally built image ID is not a registry manifest/index digest.

An installable preview still requires public access to the exact approved source, source/notice rights, complete digest-bound SBOM/provenance/signature evidence, a pull-only bundle and clean native registry-image install checks. Actual release/storage bindings, database schema identity/compatibility enforcement, doctor/bootstrap and deployment-specific UI configuration remain implementation work. The [distribution contract](distribution-contract.md) describes those proposed artifacts separately from the implemented static metadata validator.

A supported self-hosted release additionally needs verified upgrade/rollback and backup restore on a clean environment, scoped service/customer authorization, a stable integration/SDK path, operations diagnostics, measured quality/capacity and independent installation walkthroughs. Existing application recovery tests do not replace those release reports.

## Product boundaries

- Built-in financial effects are simulated; no real payment provider is included.
- Operator authentication is a deployment-wide bearer, with no SSO/invitations/full RBAC or scoped service-account lifecycle.
- Legacy MCP is configured read-only; reviewed external writes require the separate catalog/policy/ledger path.
- External PostgreSQL stores Eldhall's own tables. An existing business schema requires an explicit scoped adapter, not arbitrary model SQL.
- Single-worker/native-session storage is the currently described profile; broad multi-worker and provider/session portability are not certified.
- Redis 7.4 and native/base dependencies are not relicensed by the project's Apache grant. Rights review, required source receipts and notices remain independent publication gates.

No source/image publication or repository-visibility change follows from documentation preparation. No paid model call is required for the synthetic checks, and no production connector becomes active automatically. Follow the [implementation guide](implementation.md), [OpenAPI walkthrough](OPENAPI_QUICKSTART.md) and [licensing scope](LICENSING.md) for the implemented paths.
