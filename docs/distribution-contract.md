# Public distribution contract

Contract draft, 4 November 2026, for versioned image distribution and installation. The [strict Zod schema and semantic validator](../apps/api/src/release/manifest.ts), [JSON parser](../apps/api/src/release/parse.ts) and [generated structural JSON Schema](../schemas/release-manifest.v1.schema.json) implement metadata validation, including explicit payload-signature subjects and reserved envelope objects. The image-contained [CLI](CLI.md) supports four static commands (help, version, support config validation and release validation), plus [Linux offline init](INSTALLATION_INIT.md) that prepares private files in an explicit unbound state. Installation bundle assembly, release binding, doctor/bootstrap, actual schema epoch mapping and runtime compatibility enforcement still require implementation. No public registry image, signed release or completed installable-preview/supported-release gate is claimed.

The owner approved public Docker Hub distribution under `latkonazar` and Apache-2.0 for Eldhall code. The three selected repositories exist without published images. [Project licensing artifacts](LICENSING.md) are implemented; exact base/native inventory, required source receipts and access to the exact release source remain publication gates. Approval of public images does not establish source repository visibility. See [recipient release status](RELEASE_STATUS.md).

## Images and roles

| Repository | Roles | Required for headless install |
| --- | --- | --- |
| `docker.io/latkonazar/eldhall-server` | API, worker, one-shot migrate; offline administrative CLI | Yes |
| `docker.io/latkonazar/eldhall-web` | Operator/customer web UI | No |
| `docker.io/latkonazar/eldhall-mcp-openapi` | Fixed-target reviewed OpenAPI MCP sidecar and importer | Only for that adapter |

API, worker and migrate use the same server image reference by digest. On one platform they must resolve to the same platform manifest digest as well. A migration image from a different release is rejected even if its tag looks similar. PostgreSQL and Redis remain separate services or external dependencies. Marketing landing and analytics are outside the required product bundle.

The current server commands are `node dist/server.js`, `node dist/worker.js` and `node dist/migrate.js`; the sidecar commands are `support-mcp-server` and `support-mcp-import`. `eldhall help`, `eldhall version`, `eldhall config validate` and `eldhall release validate` run inside the server image without database/Redis/model access; the latter two perform static validation. Linux `eldhall init` creates private prepared/unbound files from explicit request/credential sources, without starting services or discovering a schema epoch. Optional UI/sidecar profiles must not be required to start a headless service. A published UI must work for the installer's domain without rebuilding; the current build-time public configuration needs its own implementation/verification before that gate passes.

Current production bases are Debian bookworm/glibc with Node 24 for server, Alpine/musl Caddy for web, and Debian bookworm/glibc with Python 3.12 for sidecar. The server includes native DSH dependencies. A release records exact base digests and resolved dependency inventory; Dockerfile tags alone do not establish reproducibility.

## Version and platform policy

The first intended preview is **`0.1.0-rc.1`**, with source tag `v0.1.0-rc.1` and image tag `0.1.0-rc.1`. It is an explicit prerelease, not a supported production/M2 promise. Candidate build identity is `sha-<full-40-character-source-sha>`; a changed build recipe/base/dependency requires a new candidate and release version. Already published version/candidate tags are never overwritten. A rerun may reuse the same verified digest or fail; it may not silently replace it.

This first release publishes no `latest`, minor or stable aliases. Release versions omit SemVer build metadata (`+...`) so the exact version remains a valid Docker tag. Install bundles pin digests. A later alias policy needs a separate change; tags are mutable pointers in the registry even when Eldhall's publication policy forbids overwriting its version tags.

Target platforms are `linux/amd64` and `linux/arm64`. Both have native source-build runtime evidence: server/web/MCP architecture and non-root/notices checks, baked server CLI identity, actual-image offline init, real DSH/MCP/worker synthetic Orders flow and UI smoke. The candidate workflow also rebuilds all three product images from the verified exact-commit source archive. These checks must cover the exact candidate being accepted; a prior successful tree does not certify a later snapshot. Neither platform has published-image pull-only evidence yet. Native source-build evidence is not registry-image verification, legal/source approval or full release readiness. Emulated/build-only results remain labelled separately; see [release status](RELEASE_STATUS.md).

Each image records its top-level index digest separately from platform manifest digests. The index identifies the platform set; a platform digest identifies one executable variant. Attestation descriptors with `unknown/unknown` platform are not runnable platforms. Install tooling verifies the chosen platform belongs to the expected index and that its digest is listed in the release. See [Docker's multi-platform structure](https://docs.docker.com/build/building/multi-platform/) and [digest reference](https://docs.docker.com/dhi/explore/security-concepts/digests/).

## Release manifest v1

`release.json` is one immutable UTF-8 JSON artifact for the whole release, with `manifestVersion: 1`. Its checksum is external in `SHA256SUMS`, avoiding a self-referential hash field. The release verifier rejects unknown manifest versions, unknown fields in v1, missing required components, duplicate keys/platforms/roles, invalid digests and inconsistent source/version/compatibility claims. The following is a field contract for implementation, not a generated manifest or a valid downloadable release.

| Field | Machine type / requirement |
| --- | --- |
| `manifestVersion` | Integer literal `1` |
| `release.version`, `release.channel` | SemVer; first value `0.1.0-rc.1`; channel literal `prerelease` |
| `release.createdAt` | RFC3339 UTC timestamp |
| `source.repository`, `source.commit`, `source.tag` | Canonical `https://github.com/LatkoNazar/eldhall`, full lowercase 40-hex commit, exact `v<version>` tag |
| `source.archive` | `{url,sha256}` for publicly retrievable exact source; no authenticated/private URL in a public release |
| `license.spdx`, `license.inventory`, `license.notices` | `Apache-2.0`; inventory and notices artifact references `{path,sha256}`; actual bundled third-party terms retained |
| `images.server`, `images.web`, `images.mcpOpenapi` | Image records below; all three are present even though web/sidecar are optional at install time |
| `dependencies.postgres`, `dependencies.redis` | `{repository,indexDigest,version,supportedMajorVersions,platforms}`; approved `docker.io/library/postgres` / `docker.io/library/redis`, exact numeric two/three-part server version, inclusive major-version range and platform/digest entries; no floating image references |
| `compatibility` | Schema, config, adapter and runtime records below |
| `artifacts` | Nonempty array of `{path,sha256,kind}`; a signature record additionally requires `subject:{path,sha256}` naming a listed non-signature artifact with matching hash. Relative paths only, no `..`, absolute paths, duplicate paths or private credentials; kinds include bundle, docs, OpenAPI, SBOM, notices, provenance and test report |
| `verification.platforms` | Per-platform records `{platform,execution,sourceCommit,imageDigests,report}`; `execution: native` required for every supported platform; `report` is `{path,sha256}` |
| `verification.installProfiles` | Per-profile `{id,platform,report}` for headless, UI, OpenAPI sidecar and external PostgreSQL paths, using registry pulls of these digests |
| `provenance` | `{issuer,workflow,sourceCommit,attestations}`; expected trusted identity plus digest-bound attestation artifact references |

`sha256` artifact fields are lowercase 64-hex strings; image digest fields include `sha256:`. URLs must be public HTTPS without embedded credentials. Artifact references must match a listed artifact's path/checksum and expected kind; signatures and license inventory are required kinds as well. `createdAt`, tags and filenames are not identity proofs. The pure metadata validator does not fetch URLs, establish public source access, inspect registry index membership, execute smoke reports or verify cryptographic attestations/signatures. Those are separate publication gates. A checksum downloaded beside a file detects mismatch; it does not authenticate the publisher.

An image record has `{repository,tag,indexDigest,roles,platforms}`. Repository is exactly its approved name above; `tag` equals `release.version`; `indexDigest` is `sha256:<64hex>`. Each platform entry has `{platform,manifestDigest,baseImages,sbom,provenance}`. `baseImages` records each runtime base repository/digest, and inventory includes build inputs separately. References to SBOM/provenance identify immutable artifacts bound to this digest. `roles` is `['api','worker','migrate']` for server, `['web']` for UI and `['mcp-server','mcp-import']` for sidecar. The static CLI is an alternate server-image command, not an independently versioned image or deployment role.

The bundle uses `repository@indexDigest` for multi-platform pulls. Host-specific locks may use the verified platform digest and explicit platform; they must retain the parent index digest in installation metadata. The installer verifies provenance for the exact digest level identified by the attestation and verifies index membership separately. It never substitutes an index digest for a platform attestation subject.

### Non-circular payload and envelope

The install payload archive contains Compose/configuration/digest-lock/docs inputs. It **excludes** `release.json`, `SHA256SUMS` and envelope signatures. Hash the finished install payload, source archive and other payload artifacts first. A payload-signature artifact signs the exact bytes of its explicit `subject`; the subject must be a listed non-signature artifact, with the same path/hash, and a distinct path from the signature. Signature-to-signature chains and signatures of envelope files are rejected. Signature records therefore cannot create a hash cycle or infer a subject from filenames.

Create `release.json` only after all payload and payload-signature hashes are known. An external detached `release.json.sig` then signs the exact final UTF-8 manifest bytes; it is **not** an artifact listed inside that manifest. The recipient verifies this envelope signature using an externally pinned trusted publisher/workflow policy before trusting fields inside `release.json`. Claimed `provenance.issuer` or `workflow` from an unverified manifest cannot establish that trust.

An external `SHA256SUMS` may list the completed payloads, source archive, manifest and detached manifest signature. It does not list itself and is not included in any hashed payload. It is a transport checksum list, not an authentication root. The distributable outer install envelope may contain the payload archive, `release.json` and external `release.json.sig`; the manifest references only the inner payload, never the outer envelope. Compute the outer envelope checksum last and retain it outside the envelope too. A release may alternatively supply those files adjacent to one another. No assembler may insert the manifest back into the payload whose hash it records. This is a dependency order, not a claim that signing/publication or installer assembly already exists.

### Private source snapshot preparation

[`scripts/source-archive.py`](../scripts/source-archive.py) prepares a vetted source/build/docs subset from a full Git commit SHA using tree/blob objects, never working-tree contents, filters, Git history or untracked files. Its fixed policy includes the product build contexts, local analytics package, synthetic Orders/support examples, selected permanent guides, schemas and source scripts. The current three Dockerfiles' ordinary local `COPY` inputs and required build files must exist in the selected tree. This static closure check is not an archive rebuild test or proof of dependency/source redistribution rights.

Private/generated paths, actual env files, non-source/media extensions, unsafe paths, links, submodules and LFS pointers are excluded; the root synthetic `.env.example` is the sole env-template exception. The tracked root `.gitignore` is included. Exact init output basenames (`support.env`, `support.json`, `installation.json`) and `.runtime` state are ignored and excluded even if force-added to Git; named synthetic `support.config.json` examples remain selected. User assets remain in the repository/workspace. The internal `SOURCE-MANIFEST.json` records commit/tree, included path/mode/blob/size/SHA256 and aggregate exclusion counts; it does not publish excluded private filenames or hash itself. Archive SHA256 and a copy of the file manifest are external sidecars. Tar member ordering/ownership/modes/timestamps and gzip filename/time/level are fixed, giving identical bytes for the same commit/policy and Python/zlib toolchain. Existing output files are never replaced.

The fixed product-guide allowlist includes the OpenAPI walkthrough, recipient release status and native-receipt guide. Historical status, starter README and internal planning/media remain excluded. A pre-write documentation gate checks target-file closure for inline Markdown links/images, reference definitions/uses and HTML `href`/`src` in selected Markdown, ignoring fenced/inline code. Local paths are percent-decoded before traversal/control checks and must resolve with exact case to an included regular file, or a directory's included `README.md`/`index.md`. Unknown schemes, absolute paths, excluded/missing targets and unsupported inline link forms fail; no file is added automatically. HTTP(S), mail/tel and protocol-relative external links are not fetched or verified. This is a bounded target-file check, not a universal CommonMark parser, heading-anchor validator or proof of public link availability. Exact Git blobs are archived without Markdown rewriting.

The command requires an explicit private `.omc` output location, for example from the checkout root:

```sh
python3 scripts/source-archive.py --commit <full-reviewed-commit-sha> --output-dir .omc/artifacts/source-review
python3 -m unittest discover -s scripts/tests -p test_source_archive.py -v
```

This creates a local review artifact, no public URL or source-access promise. The eventual owner-selected publication route, source archive/license review, exact Linux native/base corresponding-source receipts and an archive rebuild remain release gates. A filtered project snapshot does not contain dependency source merely because its lockfiles or notices identify that dependency.

## Compatibility is executable metadata

Every range is an inclusive `{min,max}` pair of nonnegative integers with `min <= max`; no omitted upper bound or wildcard. Unknown component IDs and malformed ranges fail metadata validation. The pure `checkSchemaCompatibility` helper checks both read/write bounds against observed schema epochs for API, worker or migrate. The future installer must discover/verify actual state and reject incompatibility before startup/mutation. Matching release tags are insufficient; current processes do not consume `release.json`.

| Field inside `compatibility` | Contract |
| --- | --- |
| `schemas` | Array of `{id,target,roles,migration}`; `id` is `starter` or `support`; each `roles.api`, `roles.worker`, `roles.migrate` has `{read,write}` ranges |
| `schemas[].migration` | `{from,target,fileSet}`; `from` is an inclusive schema range, `target` equals the parent target, `fileSet` is ordered `{path,sha256}` entries for the exact migration inputs |
| `config.infrastructure` | `{write,read}`: integer format produced by init and range accepted by server/CLI; this canonical infrastructure format is still to be implemented |
| `config.support` | `{write,read}` for mounted business config; existing `supportConfigSchema` has version `1` |
| `adapter.openapi` | `{manifestSchema,contract}` ranges; existing normalized manifest schema and adapter contract are both `1` |
| `runtime` | `{id,packages,sessionFormat,topology}`; initial `id: dsh`, exact package versions, bounded session-format range, `topology: single-worker` |

Schema numbers are release compatibility epochs, not SQL filename numbers or package versions. Before issuing epoch `1`, tooling must fingerprint and verify the corresponding actual schema and register the mapping: starter `0001_jobs` with its existing `alembic_version` validation; support ordered migrations `0002_support.sql` through `0008_integrations.sql`. Current support migrations have no persisted monotonic schema-version ledger. The release must implement/verify this mapping and state checks; copying `1` into metadata alone does not establish compatibility. Fresh uninitialized storage is epoch `0` only after absence of owned state is verified; an unknown existing database is not treated as empty.

A proposed first-release mapping may use target epoch `1`, API/worker read/write `[1,1]`, and migrate read/write/from `[0,1]`, **only after tests verify those claims against the actual schema**. Migration permissions allow DDL for the one-shot role; compatibility ranges do not grant credentials or authorize destructive migrations. Existing `jobs`, `alembic_version` and `support_*` tables must be available/compatible. There is no schema-isolation feature for an arbitrary business database; dedicated database is the safe installation recommendation. External DB setup never implies use of arbitrary existing business tables.

Runtime packages currently include DSH `0.2.2-alpha.2`. A release records exact resolved versions and a separately verified session storage format; it cannot infer session portability from that package number. Changing runtime/session/config/adapter compatibility requires conformance evidence, explicit upgrade notes and a new release manifest. Schema compatibility cannot promise reversal of business effects or migrations. Rollback/restore evidence remains a separate [release gate](RELEASE_STATUS.md).

## Installation bundle and local identity

The intended payload artifact `eldhall-0.1.0-rc.1-install.tar.gz` contains pull-only `compose.yaml`, explicit overlays/profiles, a digest lock, `config.example.json`, private-env template, command reference and installation guide. `release.json`, its detached signature and `SHA256SUMS` are adjacent envelope artifacts as defined above. The payload has no source build context and no hidden dependency on the author's deployment directory. Files are validated before an installer writes state. Headless is the default; external PostgreSQL/Redis selection removes the respective local service/dependency/volume from the effective configuration. External Redis recipe and the canonical overlay layout still need implementation/testing.

The implemented prepared/unbound `installation.json` is defined in [the init contract](INSTALLATION_INIT.md); it records planned resources, not discovered storage or release compatibility. The following bound-installation field set remains a future contract for installer assembly/release binding and must not be confused with init output:

| Field | Meaning |
| --- | --- |
| `installationFormat` | Literal `1`; reject unknown format |
| `installationId` | Random UUID generated once; remains stable across upgrades/restores of this installation |
| `projectName` | Stable Compose-safe slug; checked against existing storage identity before startup |
| `release` | `{version,sourceCommit,manifestSha256}` for the selected immutable release |
| `platform` | Exact runnable platform |
| `images` | Selected parent index and resolved platform digest for each enabled image; API/worker/migrate share server identity |
| `storage` | Logical store/queue/runtime bindings; include external-resource identity fingerprints, never URLs/passwords/tokens or payloads |

Storage fingerprints bind the chosen deployment resources, not credential values; token/password rotation must not change installation identity. Their canonical inputs and external-resource attestation must be designed/tested with D02 before implementation. Merely assigning different UUIDs does not isolate two deployments sharing a database or Redis namespace. The installer must refuse an accidental shared binding or require a separately supported sharing contract. Changed project name, database, queue namespace or native-session volume is a storage transition and needs explicit handling; it never silently initializes a replacement installation.

Installation metadata is separate from the release manifest and from the starter's `project:<40sha>` identity. Do not widen [the current starter parser](../scripts/project.sh) to accept arbitrary registry strings as proof of storage ownership. The new installer must validate its own persisted identity while preserving the existing starter deployment guards. Offline init currently prepares identity/configuration only. D02 still needs release binding, doctor/bootstrap and running-state compatibility checks using the authoritative application schemas.

## Candidate acceptance and remaining gates

Public release publication is independent of the author's SSH deployment. The trusted publication workflow must verify the exact allowed source/tag and required checks, build pinned inputs, emit inventory/SBOM/provenance/signatures, pull by digest into clean native environments, and publish the final manifest/bundle only after every required role/profile/platform passes. Partial uploads remain unaccepted candidates; no transactional multi-repository tag update is assumed.

Before `0.1.0-rc.1` can be called installable: verify public source access and distribution rights/notices; integrate the existing metadata validator/CLI with publication checks; build the pull-only bundle; obtain native AMD64 and ARM64 registry-image smoke; verify same server digest across roles, optional profiles and external DB; retain install/version/compatibility/provenance evidence. A separate business adapter still requires private mounts, credentials, hash review and activation.

The [release-status guide](RELEASE_STATUS.md) records the outstanding installable-preview and supported-release boundaries. Backup restore on a clean host, upgrade/rollback compatibility, scoped service accounts, semantic/capacity reports and independent walkthroughs remain separate work. No candidate tag, successful author deployment or license selection substitutes for those gates.

## Developer verification

From `apps/api`, regenerate/check the artifact and run the focused metadata tests:

```sh
node --import tsx scripts/release-schema.ts
node --import tsx scripts/release-schema.ts --check
node --import tsx --test tests/release-manifest.test.ts
```

`releaseManifestSchema.parse(value)` validates an already parsed object; `parseReleaseManifest(text)` also rejects duplicate JSON keys, including escaped equivalent names. `serverRoleImages` derives all three server roles from one index and selected platform digest. The generated Draft 2020-12 artifact describes structure and marks the semantic-validator requirement: custom field refinements (HTTPS without credentials, dot-segment rejection and no `+` in Docker version tags) and cross-field equality, range relationships and evidence-reference checks require the Zod validator too. No published manifest fixture is included; test digests are explicitly synthetic. Generation uses the existing locked Zod dependency and deterministic object-key ordering; the focused test checks the committed artifact for drift.
