# Private native OCI evidence

The native candidate workflow builds server, web and MCP once each on native Linux AMD64 and ARM64 runners from the verified exact-commit source archive. It exports a private OCI archive, validates it, and loads those same bytes into an ephemeral containerd image store for the existing CLI/init, DSH, MCP, worker and web checks. This implementation still requires successful execution of the changed native workflow; source tests alone do not establish that runtime evidence.

There is no registry login, push, external signing identity, source publication or image-archive upload. This work does not complete a published release, pull-only installation, compatibility-epoch enforcement or licensing approval. The owner's publication hold remains in force.

## Reviewed inputs and one build

[`deploy/base-images.lock.json`](../deploy/base-images.lock.json) records canonical repository/tag/index references and reviewed Linux AMD64/ARM64 child-manifest/config identities. All four tracked Dockerfiles are checked offline by `python3 scripts/base-image-lock.py --root .`; the MCP external `COPY --from` of uv is included. A digest freezes the observed `node:24-alpine` builder without upgrading it. The lock is reviewed policy, not a fresh network lookup or proof that upstream tags never move.

The same lock pins the BuildKit and SBOM scanner image indices separately from product bases. The workflow also pins the official setup action commits and exact Docker/Buildx versions. These are public anonymous pulls, without publication credentials. The [official Docker GitHub Actions guide](https://docs.docker.com/build/ci/github-actions/multi-platform/) documents the ephemeral containerd store setup. The [OCI exporter](https://docs.docker.com/build/exporters/oci-docker/) uses the `docker-container` builder driver.

Each image uses one build solve with OCI media types, forced gzip layers, explicit `oci-artifact=false`, `type=provenance,mode=min,version=v0.2`, and a digest-pinned SBOM generator. There is no second Docker build or image conversion. The [legacy attestation encoding](https://docs.docker.com/build/metadata/attestations/attestation-storage/) is an explicit supported profile; newer OCI artifact encodings and unknown compression/predicate formats fail validation until separately reviewed.

## Graph, layer and runtime binding

`scripts/candidate-image-oci.py` verifies regular safe archive entries, duplicate-safe JSON, every blob's original SHA256, descriptor sizes/media types and the entire reachable graph. There must be one runnable image for the requested native platform. Legacy attestation descriptors must point to it, and each in-toto statement's subject must independently identify that exact platform manifest. Both SPDX and SLSA v0.2 statements are required. Provenance base material repository, tag/digest and platform must match the reviewed Dockerfile policy; builder/scanner pins are recorded separately rather than invented as build materials.

Before Docker load, the verifier streams each supported raw/gzip runtime layer and checks its uncompressed SHA256 against the ordered config `rootfs.diff_ids`. It never unpacks a layer filesystem. Defensive bounds are 12 GiB per archive, 4 GiB per compressed blob, 8 GiB per expanded layer, 24 GiB expanded layers overall, 10,000 archive entries, 100 runtime layers and 32 MiB per JSON blob/statement. These prevent unbounded reads; they are not installation-size or cold-pull performance promises.

The resulting receipt keeps distinct `layoutEntrypointDigest` (the actual `index.json` bytes), `imageIndexDigest` (the referenced OCI index blob), `platformManifestDigest` and `configDigest`. The config identity comes from the verified manifest/config blob: an attested export may omit `containerimage.config.digest` in Buildx metadata. That optional field must match when supplied; the reported index digest remains mandatory and must match the graph. Docker/containerd's local image ID may identify an index or platform manifest instead of the classic config ID. The verifier classifies the observed ID, checks any runtime descriptor against the same graph, and compares actual OS/architecture and ordered RootFS DiffIDs. A probe container's actual image identity must also belong to that verified runnable graph.

Inventory, init and Compose use the returned immutable runtime ID with native platform selection. Started API, worker, migration, web and MCP container identities are checked against their corresponding graphs; the one-shot migration container is retained only until that check, then removed by isolated smoke cleanup. Mutable candidate tags select the build/load reference, not the subsequent smoke image identity. Installed native notice collection is described in [NATIVE_RECEIPTS.md](NATIVE_RECEIPTS.md).

## Retained evidence and limits

Private candidate artifacts include each role's `*-oci.json` summary and the **exact original bytes** of `*-sbom.intoto.json` and `*-provenance.intoto.json`. The summary records each statement's hash, size, platform, role, predicate and verified subject. Statements are written only after the complete graph and loaded runtime validate. Raw image configs, layers and full OCI archives stay in runner temporary storage and are never uploaded. Existing vetted-source archives remain a separate, explicitly allowlisted private review artifact.

These are unsigned local BuildKit statements, not an independent authenticity assertion. The [minimum provenance mode](https://docs.docker.com/build/metadata/attestations/slsa-provenance/) avoids rich build-argument/layer metadata. A local context does not establish a Git revision through provenance: the separate source archive receipt supplies commit/tree/archive hashes and the workflow builds from that verified extraction. The receipt labels this distinction explicitly.

The [BuildKit SBOM scanner](https://docs.docker.com/build/metadata/attestations/sbom/) supplies an SPDX inventory. It does not prove that every embedded WASM/native component or source obligation was detected. Exact native receipts, corresponding-source access/hash proof, licensing review, a future release trust policy and any later public publication remain separate gates.

Run the focused local checks with:

```sh
python3 scripts/base-image-lock.py --root .
python3 -m unittest discover -s scripts/tests -p test_base_image_lock.py -v
python3 -m unittest discover -s scripts/tests -p test_candidate_oci.py -v
python3 -m unittest discover -s scripts/tests -p test_candidate_evidence.py -v
python3 -m unittest discover -s scripts/tests -p test_source_archive.py -v
```

Real temporary OCI fixtures cover corrupted blobs, unsafe/link/duplicate members, descriptor sizes, wrong subjects/platforms/material identities, unsupported encoding, expansion bounds, exact statement retention and containerd/classic runtime-ID classifications. Actual OCI export/load and application behavior are mandatory native workflow gates, not mocked-test claims.
