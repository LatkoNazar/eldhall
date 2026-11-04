# Server image CLI

The server image contains the `eldhall` executable. Its existing default command remains the API; worker and migration Compose commands remain direct Node commands, with their existing signal handling. The CLI adds no entrypoint wrapper.

```sh
docker run --rm --network none --read-only IMAGE eldhall help
docker run --rm --network none --read-only IMAGE eldhall version
docker run --rm --network none --read-only \
  -v "$PWD/support.json:/config/support.json:ro" \
  IMAGE eldhall config validate --file /config/support.json
docker run --rm --network none --read-only \
  -v "$PWD/release.json:/config/release.json:ro" \
  IMAGE eldhall release validate --file /config/release.json
```

`IMAGE` is the locally built or separately verified server image; these commands do not imply a published image exists. Help/version require no database, Redis, model credentials or `.env`. No `init`, `doctor` or `bootstrap` command is implemented or advertised.

`config validate` uses the existing static support-config loader/schema, including embedded catalog hashes. It accepts `--file PATH`, or otherwise the process's `SUPPORT_CONFIG_FILE`. It never loads `.env`, resolves connector credentials, contacts a provider, bootstraps rows or checks database references. Successful output is `{"valid":true,"kind":"support-config","scope":"static"}`. Connector readiness and persisted activation require the normal application/operator path.

`release validate --file PATH` uses the strict release parser, including duplicate-key and cross-field checks. Output is `{"valid":true,"kind":"release-manifest","scope":"static"}`. It does not fetch images/artifacts, verify signatures or provenance, or enforce a database schema epoch. A valid synthetic test manifest is not release evidence.

Both validators omit resource values, file paths and raw parser errors from output. Exit codes are 0 for success/help, 1 for invalid or unreadable input/build identity, and 2 for invalid command arguments. Only the documented argument forms are accepted.

## Build identity

`eldhall version` returns JSON with `name`, `version`, `packageVersion`, `sourceRevision` and `buildMetadata`. The package version comes from the shipped API package. An ordinary development build uses that version, `sourceRevision:null` and `buildMetadata:"unrecorded"`; no source revision or release epoch is invented.

The server production stage accepts public build arguments `ELDHALL_VERSION` and `ELDHALL_SOURCE_REVISION`. The version must be semantic version syntax and the revision empty or a full lowercase 40-character commit. They are baked into `dist/build-info.json`; a recorded revision produces `buildMetadata:"recorded"`. This records supplied build identity, not verification of its provenance. Setting similarly named environment variables at runtime does not override the file. Never pass secrets as these public build arguments.

```sh
docker build --target production \
  --build-arg ELDHALL_VERSION=0.1.0-rc.1 \
  --build-arg ELDHALL_SOURCE_REVISION=FULL_REVIEWED_COMMIT \
  -t LOCAL_SERVER_IMAGE apps/api
```

These metadata arguments apply to the server image only in this implementation; web/sidecar build receipts must not claim to self-report the same metadata. Public source access, publication credentials, complete image licence/SBOM/source receipts and release verification remain separate gates.
