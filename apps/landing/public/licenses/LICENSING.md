# Licensing scope

Project-authored software, configuration and synthetic code examples are licensed under [Apache-2.0](LICENSE). [NOTICE](NOTICE) identifies the project; existing author and upstream notices remain intact. Choosing a licence does not change repository visibility, publish source or images, or establish rights in somebody else's work.

The licence applies to the project's contributions, including the local analytics package and synthetic Orders API example. Dependencies, native binaries, base images, externally loaded fonts and separately deployed services keep their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md) describe those boundaries. Git author display names are attribution evidence, not a claim of copyright ownership or a substitute for a contributor's rights to submit a change. This foundation introduces no CLA or DCO policy.

## Reference media excluded from the project grant

The following content is retained for development/reference but is **not granted under the project Apache licence**. Its redistribution rights have not been established by the code-licence decision:

- `docs/design-system/references/*.png`: user-supplied design references; their manifest records provenance and hashes, not a redistribution grant.
- `demos/reference/youtube/`: YouTube reference recordings, audio, vendor/demo content and rendered films, with their own provenance and third-party terms.
- `.agents/skills/eldhall-mvp-demo/assets/cursor/`: reference cursor artwork.

These paths are excluded from Git export archives by `.gitattributes`; they are not deleted or rewritten. They must also stay outside public image, installer and documentation bundles until explicit permissions or applicable separate licences are recorded. A raw repository clone or an arbitrary tar command does not apply Git export exclusions. Repository visibility and any source-publication surface remain owner decisions.

## Reproducible legal artifacts

Canonical project files are the root `LICENSE`, root `NOTICE` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The licence text is the unchanged Apache-2.0 template, including its explanatory appendix. Build-context copies are generated; do not edit them independently:

```sh
python3 scripts/license-artifacts.py --write
python3 scripts/license-artifacts.py --check
```

The generator reads only fixed project files, package locks and a bounded set of installed upstream licence files. Install frontend/landing dependencies with their normal `npm ci` commands before regeneration. It never reads environment files, invokes package installs, downloads content or scans customer data. It verifies upstream package versions against their locks, copies complete browser licence notices and records hashes of canonical inputs. Host tests run the drift check in CI. Local build validators check the legal files again inside each isolated Docker context.

| Artifact | Shipped legal files |
| --- | --- |
| API/worker | `/app/licenses/`: project LICENSE/NOTICE, scope, third-party guidance and input/hash manifest; npm retains supplied upstream notices under `/app/node_modules` |
| OpenAPI sidecar | `/app/licenses/` and the Python wheel's dist-info licence directory; installed dependency dist-info notices remain in the virtualenv |
| Web and optional landing | `/licenses/`: project files, scope, complete browser notices and input/hash manifest; Vite copies this public directory to dist |

React, react-dom and scheduler MIT notices ship in the web artifact. Vite's generated browser-runtime helper licence is included in both web and landing notices; this does not mean the Vite build tool is shipped as a server dependency. Public artifacts must preserve this directory even when minification removes upstream comments.

## Public release gates still open

This is a licensing foundation, not completion of D13-02 or approval to publish. Before distributing images, verify the exact Linux ARM64/AMD64 artifact inventory, base-image digest/SBOM, native LGPL/MPL component notices, corresponding-source availability and build receipts. Preserve complete upstream terms and document how recipients obtain the required source. Browser notice validation covers the identified bundled components, not every possible future dependency or asset.

Production Dockerfiles declare only the custom `io.eldhall.project.license=Apache-2.0` label with an explicit project scope. The standard `org.opencontainers.image.licenses` describes contained software under the [OCI annotation specification](https://github.com/opencontainers/image-spec/blob/main/annotations.md); a complete image-wide expression is deferred until the exact base/native inventory is verified. No aggregate expression is guessed from the project licence.

Redis 7.4 is a separately pulled service with RSALv2/SSPLv1 terms; the whole stack must not be described as Apache licensed. Media grants, contributor licensing authority, the public source access path and the reviewed publication credential/workflow remain separate release gates. Do not infer any of them from a generated hash manifest or from ownership of the `latkonazar` Docker Hub namespace.
