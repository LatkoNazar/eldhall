# Native image review inputs

The candidate workflow collects installed native fingerprints and bounded notice/build metadata from the exact local image it tested. This supplies review inputs for D01/D13. This collector does not fetch corresponding source or attest that distribution obligations are satisfied. The separate [private OCI evidence gate](PRIVATE_OCI.md) generates and retains unsigned BuildKit SPDX/provenance statements; neither lane publishes source or images.

## What the evidence identifies

`server-npm-inputs.json` records installed package path/name/version/package-manifest SHA256 and binary fingerprints. Binary format is detected by magic bytes: `7f454c46` for ELF and `0061736d` for WebAssembly, independently of file extension. Each fingerprint includes the original file size/SHA256 and its owning package identity. Native fingerprints describe files present in the image; they do not prove that every file was loaded by a request.

`server-native-review-inputs.json` contains:

- `format: eldhall-native-review-inputs-v1`, exact server `imageId` with explicit `imageIdKind`, structurally verified OCI index/platform/config identities, architecture and resolved build-material hashes;
- raw `buildxOutputDigest` with `buildxOutputDigestKind: unverified-local-exporter-digest`;
- source revision and vetted-source build receipt;
- selected installed native components, their binary fingerprints and byte-exact notice/build-source metadata receipts;
- explicit `missingKinds` and `sourceAvailability: not_verified`.

All image inventory commands run by the verified immutable image ID with explicit native platform selection after the OCI graph/config/RootFS binding is checked. They use no network, a read-only filesystem, no host mounts and no supplied application environment. The collector reads fixed installed package locations, never `.env`, chats, provider keys or business configuration.

Historically, Buildx `--load` reported the config image ID as `containerimage.digest` for all three PR #12 images. That value alone was not a platform manifest/index proof. `buildxOutputDigest` still preserves the raw value without guessing its type. The new OCI gate supplies separate structural identities and checks that Buildx output matches the actual graph. Docker/containerd may identify the index or platform manifest as the local image ID; `imageIdKind` records its verified meaning instead of assuming equality with `configDigest`.

## Installed receipt policy

Text collection is restricted to `sharp`, installed `@img/sharp-{libvips-}linux{musl}-{x64|arm64}` packages, and `@deepseek-ai/libreoffice-kit` / `libreoffice-kit-wasm`. This is a bounded component selection, not an exhaustive inventory of all third-party source obligations.

Within those packages the collector retains complete recognized LICENSE/LICENCE/COPYING/NOTICE/copyright files, third-party notice filenames and files under licence directories. Fixed root metadata filenames include `package.json`, `README`/`README.md`, `versions.json`, `versions.properties` and explicit build/source-info JSON names. It never follows a URL found in these files or reconstructs a notice from the npm `license` field.

The exact upstream [sharp-libvips v1.3.4 package descriptor](https://github.com/lovell/sharp-libvips/blob/v1.3.4/npm/linux-x64/package.json) includes the binary library and `versions.json`. Its [packaging script](https://github.com/lovell/sharp-libvips/blob/v1.3.4/populate-npm-workspace.sh) generates package `README.md` from the third-party notices and removes the standalone notice file for runtime packages. The collector therefore treats the installed sharp-libvips root README as a notice, including when that package is nested beneath another dependency. It retains the actual installed bytes, not the current upstream website's text. The [exact upstream build script](https://github.com/lovell/sharp-libvips/blob/v1.3.4/build/posix.sh) is research context; the collector does not download or execute it.

Every retained text receipt includes its installed path, relative package path, kind, original byte size/SHA256, `encoding: utf-8`, complete text and package identity. UTF-8 bytes must round-trip exactly, preserving BOM, CRLF and trailing newlines. Invalid UTF-8 or oversized/unreadable files fail collection; text is never normalized or truncated. Missing notice/metadata/binary kinds remain explicit. A README or declared source URL is not a verified corresponding-source receipt, so source availability stays `not_verified`.

Bounds are one million bytes per text file, two million per component, six million retained text bytes overall, 100 text receipts per component and 30 selected components. The existing eight-million-byte artifact limit and bounded filesystem/binary scan also apply. Binary bytes are hashed, not retained; only the selected text files are copied into JSON. Public upstream retrieval, if later needed, must be a separate reviewed operation with an explicit pinned origin and content hash.

## Verification and evidence limits

Run `python3 -m unittest discover -s scripts/tests -p test_candidate_evidence.py -v`. Real filesystem fixtures cover nested sharp-libvips generated README notices, package/versions metadata, ELF/WASM magic versus misleading extensions, immutable image binding, BOM/CRLF round-trip, missing receipts and invalid/oversized text. They also cover Buildx digest equality without a manifest-digest claim.

Native AMD64/ARM64 workflow execution supplies actual image receipts. Earlier PR #12 receipts establish the observed versions/paths and the missing coverage addressed here; they do not contain the new WASM fingerprints or notice text. Required source availability, actual upstream source hashes/build instructions and legal review remain separate gates. Project Apache-2.0 licensing does not replace the terms in these observed third-party files.
