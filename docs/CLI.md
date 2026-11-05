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

`IMAGE` is the locally built or separately verified server image; these commands do not imply a published image exists. Help/version require no database, Redis, model credentials or `.env`. [`init`](INSTALLATION_INIT.md) prepares private local files offline on Linux; it does not start an installation. No `doctor` or `bootstrap` command is implemented or advertised.

`config validate` uses the existing static support-config loader/schema, including embedded catalog hashes. It accepts `--file PATH`, or otherwise the process's `SUPPORT_CONFIG_FILE`. It never loads `.env`, resolves connector credentials, contacts a provider, bootstraps rows or checks database references. Successful output is `{"valid":true,"kind":"support-config","scope":"static"}`. Connector readiness and persisted activation require the normal application/operator path.

`release validate --file PATH` uses the strict release parser, including duplicate-key and cross-field checks. Output is `{"valid":true,"kind":"release-manifest","scope":"static"}`. It does not fetch images/artifacts, verify signatures or provenance, or enforce a database schema epoch. A valid synthetic test manifest is not release evidence.

Both validators omit resource values, file paths and raw parser errors from output. Exit codes are 0 for success/help, 1 for invalid or unreadable input/build identity or refused offline preparation, and 2 for invalid command arguments. Only the documented argument forms are accepted.

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

## Local browser demo

With locked development dependencies installed, open two terminals at the repository root. Docker and external services are not required. In the first terminal, start the API:

```sh
cd apps/api
npm run demo:local
```

This explicit launcher binds only `127.0.0.1:8000`, accepts no arguments and uses the public demo key `1111`. It ignores ambient application settings and `.env`: support and starter jobs run in memory, replies use deterministic rules, payments are simulated and the seeded customers/businesses are synthetic. It creates no PostgreSQL, Redis, provider or business-integration connections. URL imports are disabled. Restarting loses all demo changes. Readiness reports the actual memory component, not fictitious database/Redis health.

In the second terminal, start the frontend:

```sh
cd apps/frontend
npm run demo:local
```

Open [the local operator form](http://127.0.0.1:5173/operator) and enter `1111`, or use [the local demo key link](http://127.0.0.1:5173/operator#key=1111). Both paths validate the key with the API before opening the dashboard.

The dedicated frontend launcher binds `127.0.0.1:5173`, fixes its proxy to this local API, disables `.env` loading and external analytics, and rejects extra arguments. Do not expose this weak-key fixture through a LAN-facing development proxy or tunnel. Production still requires the existing strong `OPERATOR_TOKEN`; `1111` is not a production credential.

`GET /api/v1/operator/session` checks only the supplied `Authorization: Bearer …` operator key. It returns `200 {"authenticated":true}` or a generic `401`, with `Cache-Control: no-store`. It does not query storage, providers or dependency readiness, and creates no cookie or server session.
