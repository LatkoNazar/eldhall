# D01 — Docker Hub, версії образів і відтворюваний реліз

**Пріоритет:** P0 для першого публічного self-hosted релізу.  
**Передумови:** завершений [основний план OpenAPI/MCP](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md); погоджена ліцензія вихідного коду та перевірені умови розповсюдження залежностей.  
**Результат:** користувач встановлює перевірений реліз через Docker Hub без clone, Node/Python на host і локальної збірки.  
**Baseline:** commit `858985f38b82e4e26dafb563e4e794ff01cc9196`; це план, не опис доступного релізу.

**Приватне виконання, 4 листопада:** актуальна прийнята база — [`91ba9519`](https://github.com/LatkoNazar/eldhall/commit/91ba9519e6da800d1fb4063acaa43a39baa35cd4). Owner відклав створення public source repository та публікацію коду й образів до окремого явного рішення про готовність. Продовжуємо реалізацію та перевірки в приватному репозиторії; publication credentials не налаштовуємо. D01 і M1 загалом **не завершені**.

Позначені нижче критерії підтверджені поточним source contract та [native AMD64/ARM64 перевірками PR #14](https://github.com/LatkoNazar/eldhall/actions/runs/41866631870), а не встановленням із Docker Hub. [Distribution contract](../docs/distribution-contract.md), [поточні межі](../docs/RELEASE_STATUS.md) та [облік D00](00-baseline-and-release-gates.md) відділяють реалізовані частини від майбутнього release/install workflow. Розділ 1 зберігає історичний baseline; його старі CI/deploy результати не описують стан поточного production.

## 1. Що вже є

[API Dockerfile](../apps/api/Dockerfile) має multi-stage build, production dependencies, non-root користувача і persistent DSH directory. API, worker та migration вже використовують один server image з різними командами. Це правильна основа.

[Standalone Compose](../deploy/support.compose.yaml) уже відділений від landing/Umami, але містить `build` і defaults `support-server:local` / `support-web:local`. [CI](../.github/workflows/ci-cd.yml) збирає образи звичайним `docker build`; deploy перевіряє збіг архітектури runner/server, робить `docker save` та передає bundle через SSH. Docker Hub publication, release manifest і перевірка опублікованих multi-platform images у цьому workflow відсутні.

[scripts/project.sh](../scripts/project.sh) трактує image reference як `project:<40-character-sha>`. Такий parser не підтримує registry namespace і digest. Його потрібно адаптувати або відокремити від нового installer, зберігши захист deployment identity.

Для цієї ревізії [CI job check успішний](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605/job/124672861754), а [deploy впав на Configure verified SSH connection](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605/job/124673960286). Це не падіння тестів; причину всередині SSH setup тут не діагностовано. Публікація продуктового релізу має бути незалежною від доступності особистого deployment server.

## 2. Цільовий контракт постачання

Один реліз має узгоджений набір:

| Артефакт | Роль |
| --- | --- |
| `docker.io/latkonazar/eldhall-server:<version>` | API, worker, migration, admin CLI |
| `docker.io/latkonazar/eldhall-web:<version>` | Опційний operator/customer UI |
| `docker.io/latkonazar/eldhall-mcp-openapi:<version>` | Опційний Python adapter із головного TODO |
| Release manifest | Source SHA, image index/platform digests, schema/config compatibility |
| Installation bundle | Compose без build contexts, приклад конфігурації, checksums, інструкція |
| Release notes | Зміни, migrations, сумісність, відомі обмеження, rollback instructions |

Namespace `latkonazar` і назви трьох образів погоджені. Репозиторії створено порожніми до відкладення публікації; це не означає, що образи чи версії вже доступні. `<version>` залишається placeholder для майбутнього перевіреного релізу. Поточний canonical source repository приватний; нового public repository немає. Власний підтримуваний образ не називати Docker Official Image.

### D01-01 — Визначити package contract

- [x] Зафіксувати назви образів, підтримувані платформи `linux/amd64` і `linux/arm64`, source repository та channel policy.
- [ ] API/worker/migrate одного deployment повинні використовувати той самий server digest.
- [x] Зберегти окремі PostgreSQL/Redis services; не запускати їх усередині server image.
- [ ] Опційні UI/MCP images мають сумісні protocol/config versions. Відсутність цих profiles не заважає headless запуску.
- [ ] Маркетингові landing/analytics не включати до обов'язкового install bundle. Contract і standalone Compose вже відділяють landing/Umami; перевірка вмісту готового install bundle ще попереду.
- [x] Задокументувати distro/libc та native runtime залежності. Успіх TypeScript build не доводить працездатність DSH на ARM64.

### D01-02 — Версії та release manifest

- [ ] Використовувати semantic version для релізу, `sha-<source-sha>` для candidate build і explicit prerelease channel для тестових версій.
- [ ] Не перезаписувати вже випущений patch-version image. Для rebuild із новим base/dependency випускати нову версію з release notes.
- [ ] `latest`/minor aliases, якщо додані, вважати рухомими покажчиками. Production examples використовують конкретний реліз; installation bundle фіксує digests.
- [ ] Manifest містить source SHA, release version, server/web/MCP digests, platform list, target schema, config version, release timestamp і machine-readable supported read/write schema ranges. Перевіряється і нижня, і верхня межа сумісності для API/worker/migrate.
- [ ] Врахувати, що digest multi-platform index відрізняється від platform image digest; перевіряти правильний рівень.
- [ ] Серверний `version` command і capabilities endpoint повертають version/source SHA/schema compatibility без секретів.
- [ ] Зміна одного optional image також створює узгоджений новий release manifest.

### D01-03 — Побудова та native verification

- [ ] Створити окремий release workflow, не змішувати publication з наявним SSH deployment на власний сервер.
- [ ] Зафіксувати build actions за reviewed commit SHA, base image digests і lockfiles; залежності оновлювати через review.
- [x] Buildx збирає обидві платформи. Native runner smoke на AMD64 та ARM64 запускає саме готові platform images.
- [x] На кожній архітектурі перевірити API startup, migrations, worker claim, DSH із deterministic local model fixture, persistence і Python MCP handshake.
- [ ] QEMU допускається як допомога збірці. Результат emulated test позначати окремо; він не замінює native compatibility evidence.
- [ ] Обмежити runtime image потрібними compiled files, production dependencies, migrations і CLI; development/demo media не копіювати.
- [ ] Перевірити non-root UID, read-only root filesystem, writable volume ownership, signal forwarding і graceful stop.
- [ ] Заміряти compressed/uncompressed image sizes і cold pull time; встановити budget після baseline, без вигаданого числа «легкий образ».

[Docker описує Buildx multi-platform workflow та відмінності між build/push і локальним image store](https://docs.docker.com/build/ci/github-actions/multi-platform/). Вибір конкретних Action versions звірити під час реалізації.

### D01-04 — Trusted publication

- [ ] Release candidate публікує лише trusted workflow для затвердженого tag/source commit.
- [x] Fork/PR jobs збирають і тестують без Docker Hub credentials, signing identity або production secrets.
- [ ] Token має мінімальні права лише на потрібні registry repositories; пароль особистого акаунта в CI не використовувати.
- [ ] Перевірити, що release tag посилається на дозволений commit, а всі required checks стосуються саме його.
- [ ] Workflow permissions задавати по jobs; OIDC/signing permission доступний лише publication stage.
- [ ] Registry outage, partial upload або failed smoke залишають candidate; stable release не публікується.
- [ ] Повтор workflow для того самого candidate має бути передбачуваним: reuse already verified digest або створення нового candidate без непомітного overwrite.

### D01-05 — Перевірити те, що завантажить користувач

- [ ] Після push підняти clean environment і `pull` образи за digest із registry.
- [ ] Запускати customer-path smoke із release bundle без робочої копії repo та без build cache.
- [ ] Перевірити default headless, optional UI, OpenAPI sidecar і external database recipe.
- [ ] Зіставити reported version, source SHA та schema versions із manifest.
- [ ] При невідповідності будь-якого образу весь candidate вважати неготовим.
- [ ] Публікувати release manifest/готовий installation bundle тільки коли всі обов'язкові компоненти перевірено.
- [ ] Не обіцяти атомарної зміни кількох Docker tags: registry не надає транзакцію для всього набору. Узгодженість забезпечує один release manifest із immutable digests; aliases оновлюються після нього.

### D01-06 — Вміст образу та походження

- [ ] Генерувати SBOM і build provenance разом із candidate; зберігати їх прив'язаними до digest.
- [ ] Підписувати release digest trusted CI identity й дати користувачу відтворювану команду перевірки issuer/workflow identity.
- [ ] Release notes включають результати dependency/container vulnerability review і явні обґрунтовані винятки з owner/expiry.
- [ ] Scanner finding не дорівнює доведеній експлуатації; блокувальні критерії визначити за severity, reachability і наявністю виправлення.
- [ ] Не передавати секрети через build args. Provenance може містити їхні значення; для приватних build dependencies використовувати secret mounts.
- [ ] Забезпечити lifecycle виправлень: patch image, advisory за потреби, оновлення supported releases.
- [ ] Якщо згодом додано registry mirror, зберігати digest/attestation consistency або явно публікувати окремі verified digests.

[Docker attestations](https://docs.docker.com/build/ci/github-actions/attestations/) пояснює SBOM/provenance і небезпеку secret build args; [GitHub publication guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) описує publication та прив'язку attestations до image digest.

### D01-07 — Docker Hub як точка входу

- [ ] README кожного образу: призначення, підтримувані architectures, ролі/команди, config/env, ports, volumes, healthcheck, license, release/support policy.
- [ ] Дати один canonical install link на конкретну версію bundle.
- [ ] Приклади містять placeholders і синтетичні дані; реальні tokens або бізнесові OpenAPI artifacts не публікуються.
- [x] Вказати, що server потребує PostgreSQL/Redis, а правила/модель настроюються окремо.
- [ ] Додати troubleshooting для image platform mismatch, registry authentication/rate limits, disk full, failed migration.
- [ ] Для закритої мережі описати повторюваний offline export/import **того самого release manifest**, включно з залежними images і перевіркою checksums.

## 3. Файли і порядок виконання

Спочатку Dockerfile/role contract та pull-only Compose; далі release manifest/build matrix; потім registry smoke, provenance/signing і publication. Installation UX виконується разом із [D02](02-installation-and-configuration.md); upgrade/rollback gates — із [D03](03-upgrades-backups-and-restore.md).

Змінювані місця: `apps/api/Dockerfile`, `apps/frontend/Dockerfile`, майбутній `apps/mcp-openapi/Dockerfile`, новий release workflow, `deploy/`, `scripts/project.sh` або його наступник, release metadata/CLI, Docker Hub README generator. Поточний source-build workflow лишається шляхом для розробників, доки migration на новий distribution flow не перевірена.

## 4. Definition of Done

- [ ] Чиста AMD64 машина та ARM64 машина встановлюють однаковий реліз без repo checkout/local build.
- [ ] Candidate, що не пройшов runtime smoke або compatibility check, не з'являється як stable release.
- [ ] Fork PR не може отримати publication secrets чи підписати артефакт.
- [ ] Digest, source commit, signatures/SBOM і compatibility metadata доступні та перевіряються.
- [ ] API, worker, migration, optional UI/MCP проходять documented install/upgrade tests саме з published images.
- [ ] Є збережені CI run links, release manifest, обидва platform smoke reports та перевірена Docker Hub інструкція.

Kubernetes operator, Helm chart, власний package registry і формальний статус Docker Official Image не є умовами завершення D01.

