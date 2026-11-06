# Third-party components

This file identifies known distribution boundaries. It is not a replacement for the licence/copyright notices shipped by each dependency, a complete Linux-image SBOM, or a declaration that all components have the project's Apache licence.

## Server

The production npm tree is determined by `apps/api/package-lock.json` and `npm ci --omit=dev`. Most packages declare MIT, Apache, BSD or ISC-family terms. Preserve the actual installed notices, including nested dependencies and platform-selected native packages.

- DeepSeek Harness `0.2.2-alpha.2` packages carry DeepSeek MIT notices. The production tree also includes office and image-processing dependencies even when the support facade does not expose those tools.
- `@deepseek-ai/libreoffice-kit` `0.1.5` is MPL-2.0. Its NOTICE retains DeepSeek MIT and LibreOffice/ASF attributions. Linux selects the optional WASM engine. Keep its complete engine/component licences and source/build receipts; a Windows engine's notice inventory cannot certify the Linux artifact. [Upstream licence](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/LICENSE) and [packaging/source receipts](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/docs/packaging.md).
- `sharp` `0.35.5` declares Apache-2.0; its Linux libvips bundles `1.3.4` declare LGPL-3.0-or-later and include other component terms. Keep exact bundle notices and the corresponding-source/build information required by those terms. Do not replace the bundle's terms with the generic libvips source licence. [Upstream packaging](https://github.com/lovell/sharp-libvips/blob/main/README.md#licences).
- Native helpers including node-pty, ripgrep, koffi and Node addon loaders retain their MIT/BSD notices. Node and the Debian base contain additional runtime/OS components outside the npm lock.

Exact Linux native/bundled-component and base-image compliance is a public-release gate; the project Apache licence does not discharge these obligations. MPL permits a separately licensed larger work when covered-component conditions are met; it still requires the relevant source availability and notices. [MPL-2.0 responsibilities](https://www.mozilla.org/en-US/MPL/2.0/).

## Python sidecar

`apps/mcp-openapi/uv.lock` controls the dependency versions; the final virtualenv excludes development Ruff. FastMCP and rfc8785 declare Apache-2.0; HTTPX, Starlette and Uvicorn BSD-family terms; MCP and Pydantic MIT. Cryptography offers Apache-2.0 OR BSD-3-Clause. Certifi's CA bundle is MPL-2.0. Preserve installed dist-info licence files, certificates' notices and Python/base-image licences. The lock alone is not a licence inventory of native wheels or their bundled libraries.

## Browser artifacts and fonts

The web artifact includes React, react-dom and scheduler MIT-licensed code. Both interfaces use MIT-licensed i18next; the application also includes react-i18next and its MIT-licensed runtime dependencies (@babel/runtime, html-parse-stringify and use-sync-external-store). Complete upstream licence text, package names and locked versions are generated into `/licenses/BROWSER_NOTICES.txt`. Both browser artifacts include the Vite core MIT notice for generated runtime helpers; build-only dependencies such as parse5 are not thereby declared bundled in full. The local analytics and localization code are covered by the project licence.

The application self-hosts **Google Sans 14.000**, independently licensed under **SIL OFL-1.1**. The two unmodified normal/italic variable TrueType files come from the official [v14.000 release](https://github.com/googlefonts/googlesans/releases/tag/v14.000), using its Android variable builds (weight 400–700). Their original bytes, source archive/commit, copyright metadata and SHA-256 hashes are recorded in `apps/frontend/public/fonts/google-sans/manifest.json`. The complete upstream `OFL.txt` ships beside both fonts and is retained in the application's `/licenses/BROWSER_NOTICES.txt`. The upstream licence header names the Google Sans Flex Project Authors; it is preserved verbatim alongside the Google Sans binaries' copyright attribution. These fonts are not relicensed under Apache-2.0. Offline source/build checks require the exact reviewed files, licence and manifest; the built web artifact is checked again for missing or changed font bytes.

The optional landing retains its existing Inter runtime Google Fonts loading; Inter remains under [OFL-1.1](https://github.com/rsms/inter/blob/master/LICENSE.txt). Reference screenshots and YouTube demo media are excluded from the project grant; see LICENSING.md.

## Separate images and services

Node/Python Debian bases and Caddy's Alpine base retain their runtime/OS component terms. Preserve their licences and record the exact published-image digest/SBOM before distribution.

Compose pulls `redis:7.4.11-alpine` separately. The [exact Redis 7.4.11 licence](https://github.com/redis/redis/blob/7.4.11/LICENSE.txt) offers RSALv2 OR SSPLv1; it is not Apache/BSD. The npm `redis` client has different MIT terms. PostgreSQL, optional Umami, and any external MCP/KB/provider service also have their own terms. No re-licensing of those services, trademark permission or public source access is implied by this project.
