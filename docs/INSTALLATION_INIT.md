# Offline installation preparation

`eldhall init --directory NEW_CHILD_DIRECTORY --request-file PATH` prepares three private files on Linux without a database, Redis, model request, Docker socket or network. It does not create containers, volumes, queues, database records or customers. It does not migrate or start services. Existing API, worker and migration commands are unchanged.

The output is an installation intent, explicitly `prepared` with an `unbound` release binding. A successful command does not establish release acceptance, infrastructure ownership, database identity/schema epoch, provider access or application readiness. Public images and a complete pull-only installation bundle remain separate release work.

## Request

Create a bounded UTF-8 JSON request. An evaluation request uses the deterministic rules provider and persistent production settings with demo reset disabled:

```json
{
  "initRequestFormat": 1,
  "project": "bank-support",
  "mode": "evaluation",
  "database": { "mode": "bundled" },
  "provider": { "id": "rules" }
}
```

Production requires an explicit model provider and model. For example:

```json
{
  "initRequestFormat": 1,
  "project": "bank-support",
  "mode": "production",
  "database": { "mode": "bundled" },
  "provider": {
    "id": "openai",
    "model": "YOUR_CHOSEN_MODEL",
    "key": { "file": "/inputs/provider-key" }
  }
}
```

Supported production provider IDs are `google`, `openai`, `anthropic` and `local`. A local provider requires `model` and an HTTP(S) `baseUrl` without credentials, query or fragment; its `key` is optional. Other providers require a key source. This command validates settings, not model availability.

Each credential source is exactly one of `{"file":"PATH"}` or `{"env":"EXPLICIT_VARIABLE_NAME"}`. Only explicitly named environment variables are read. An ambient provider key or `DATABASE_URL` is never selected automatically. Secrets in command arguments or inline request values are unsupported. File references are resolved from the process working directory, not the request file's directory. Input files must be bounded regular files; symlink input files are refused on Linux.

Secret files contain the exact value with no final newline. Values preserve spaces, dollar signs, hashes, quotes, backslashes and Unicode. Control characters, multiline values, invalid UTF-8 and lone surrogates are refused before creating the output directory. Request JSON rejects unknown fields, duplicate keys and unsupported versions. Requests are limited to 64 KiB and each resolved credential to 16 KiB.

For an existing PostgreSQL server, explicitly choose:

```json
"database": {
  "mode": "external",
  "url": { "file": "/inputs/database-url" }
}
```

The literal PostgreSQL URL is written only to private `support.env`; it is excluded from the installation record and command output. No connection is attempted and no database objects are created. The external mode does not generate split PostgreSQL credentials or claim a local PostgreSQL volume. Redis remains planned locally; this slice supplies no external Redis deployment recipe.

## Run with a writable parent

The destination must be a new child of an existing writable directory. Native Windows/macOS preparation is refused because this implementation requires Linux private modes, no-follow directory handles and `/proc/self/fd`. Running the Linux image on a bind mount still requires that filesystem to honor Linux ownership and modes.

The server image runs as UID 1000. Provision a dedicated parent writable by that user using the host's normal ownership mechanism, then mount it at `/installation`. Do not mount a pre-created final directory or relax permissions with `chmod 777`. Mount input files read-only:

```sh
docker run --rm --network none --read-only \
  -v "$PWD/installation-parent:/installation" \
  -v "$PWD/inputs:/inputs:ro" \
  IMAGE eldhall init \
    --directory /installation/bank-support \
    --request-file /inputs/request.json
```

`IMAGE` denotes a locally built or separately verified server image, not a claim that registry publication has occurred. This command needs no Docker socket in the container. If using an explicitly named environment source, make that single value available to the process through your secret-management mechanism; the command does not discover ambient credentials.

Success emits only:

```json
{"status":"created","state":"prepared","releaseBinding":"unbound","files":["support.env","support.json","installation.json"]}
```

A matching repeat emits `"status":"reused"`. Errors emit constant reasons without paths, credential values or raw parser messages. Exit codes are 0 for success, 1 for refused preparation and 2 for invalid command arguments.

## Files and repeat behavior

The new directory is mode `0700`; each file is mode `0600`, owned by the creating user. The command uses exclusive file creation and refuses symlink destinations/ancestors, unsafe ownership, permissive modes, hard-linked state files, extra files, conflicting state and partial directories. It never changes permissions on an existing installation directory or repairs its state.

| File | Meaning |
| --- | --- |
| `support.env` | Private Compose-only environment, including freshly generated cryptographic API/operator/Redis keys and bundled PostgreSQL password where selected. |
| `support.json` | Empty valid support configuration: no businesses, knowledge, skills, integrations, customers or synthetic payments are added. |
| `installation.json` | Strict `installationFormat:1` identity with a stable UUID, intent, prospective namespaces and the CLI's recorded build identity. It contains no provider key or database URL. |

`support.env` is encoded for Docker Compose `--env-file`. Do not `source` it in a shell or parse it with Node dotenv/`util.parseEnv`; their escaping semantics differ. The generated file has a strict canonical decoder for repeat validation. Actual Compose dotenv parsing is tested against literal interpolation-looking values; Linux candidate validation must separately verify service environment injection and private filesystem behavior.

The explicit interoperability command is `node --import tsx --test tests/installation-compose.integration.ts` from `apps/api`; it requires a real Docker Compose CLI and fails if unavailable. The ordinary API unit suite has no Docker requirement.

Repeat preparation compares the existing identity, support configuration and canonical environment with the same explicit request and resolved credentials. It preserves the UUID, generated keys, bytes, modification times and original `preparedBy` build identity. A different intent or supplied credential is refused rather than rotated. This is not a tamper-proof signature or original-secret attestation; independently valid manually changed service keys cannot establish their own provenance.

The identity marker is written last after the other private files are flushed. An interruption may leave a private partial directory; a later run refuses it without deleting or overwriting anything. Inspect and resolve partial state separately; no `--force`, automated cleanup or secret rotation command is provided.

The full UUID supplies entropy for the planned Compose project/resource names and queue prefix. These names are prospective only: recording them does not prove that resources exist, are exclusively owned, or that runtime Compose wiring already consumes the identity. Structural JSON schemas are in [`init-request.v1.schema.json`](../schemas/init-request.v1.schema.json) and [`installation.v1.schema.json`](../schemas/installation.v1.schema.json); the application additionally enforces cross-field mode/provider and namespace derivation checks.
