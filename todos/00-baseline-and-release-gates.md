# D00 — Перевірена база, залежності та критерії релізу

**Оновлено:** 2026-11-04. **Прийнята source база:** [`5ae3066ba96a87e6fc9e6822599143fd2305dd41`](https://github.com/LatkoNazar/eldhall/commit/5ae3066ba96a87e6fc9e6822599143fd2305dd41), після [PR #11](https://github.com/LatkoNazar/eldhall/pull/11) і [PR #12](https://github.com/LatkoNazar/eldhall/pull/12). Попередній roadmap checkpoint — [`7728f5d`](https://github.com/LatkoNazar/eldhall/commit/7728f5d7371e9cbaacb7d77fe3dab9923c52d995); основний TODO завершувався на runtime source `2ba80ca4c727c8b52ac1a91e6f8296f287487efd`.
**Історичний snapshot:** 2026-11-01, [`858985f38b82e4e26dafb563e4e794ff01cc9196`](https://github.com/LatkoNazar/eldhall/tree/858985f38b82e4e26dafb563e4e794ff01cc9196). Вихідний D00 опубліковано пізніше у [незмінному roadmap commit `295bce3`](https://github.com/LatkoNazar/eldhall/blob/295bce336afc67f07974bf60c276ac060f4a9201/todos/00-baseline-and-release-gates.md).
**Призначення:** дати спільний baseline для всіх планів у `todos/` та не змішувати наявні механізми з майбутніми обіцянками.
**Попередній етап:** [основний TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md).

## 1. Метод і межі перевірки

Початковий план 1 листопада спирався на читання source і CI без нового запуску. Оновлення 4 листопада звіряє прийнятий source, permanent docs та фактичні CI/deployment reports із розділу 4, включно з native AMD64/ARM64 source-build і offline-init evidence. Це не новий benchmark або встановлення з Docker Hub.

Основний OpenAPI/MCP permissions етап завершено: [PR #9](https://github.com/LatkoNazar/eldhall/pull/9), [PR #10](https://github.com/LatkoNazar/eldhall/pull/10), [статус і перевірки](../docs/STATUS.md). Кореневий TODO видалено після перенесення контрактів у permanent docs. Передумова початку цієї roadmap виконана; задачі D01–D14 і рівні M1/M2 цим не завершені.

Знайдені обмеження нижче є engineering gaps або питаннями, які треба перевірити. Наприклад, process-local lock сам по собі не доводить фактичну multi-worker race; для цього потрібні topology contract і process-level tests.

## 2. Наявна інженерна основа

- PostgreSQL зберігає product state; Redis/BullMQ використовується для доставки роботи.
- Приймання повідомлення і durable turn job пов'язані транзакційно; є leases/fences, bounded recovery і finalization.
- Approval відокремлений від execution, прив'язаний до hash; для платежів існує reservation і `unknown` outcome.
- Model-facing tools контролює trusted gateway; scope походить від backend.
- Є runtime tests із реальним DSH та fake model endpoint, MCP transport tests і PostgreSQL integration suites.
- Є reviewed OpenAPI import, authenticated fixed-target MCP sidecar, PostgreSQL-authoritative permissions/review/activation, Integrations UI та durable external actions із expiry, invalidation і reconciliation.
- Є standalone support Compose, optional UI і external PostgreSQL recipe.
- Є release/deploy/rollback/backup scripts із чинними guards.
- Є versioned knowledge, retrieval, classifications та Insights.
- Є Apache-2.0 project license/NOTICE, scoped package/image metadata, shipped browser notices та reproducible legal-artifact drift checks; third-party умови збережені.
- Є strict release metadata parser/semantic validator і versioned JSON Schemas; static image-contained CLI не потребує DB/Redis/model access.
- Є Linux offline init із private files, stable prepared/unbound identity, explicit credential sources і refusal без overwrite; він не запускає services і не встановлює release/storage ownership.
- Є native AMD64/ARM64 candidate smoke, включно зі збіркою server/web/MCP із exact-commit source archive та actual-image init.

План продовжує цю основу. Кожна заміна має зберігати її behavioral invariants.

## 3. Карта конкретних прогалин

| Спостереження на baseline | Наслідок для стороннього користувача | Task owner |
| --- | --- | --- |
| [Distribution contract](../docs/distribution-contract.md), release schema/validator і private candidate CI реалізовані; [deployment CI](../.github/workflows/ci-cd.yml) доставляє release через SSH/docker save | Trusted registry publication, signed digest-bound artifacts і pull-only install ще не реалізовані | D01 |
| [Standalone Compose](../deploy/support.compose.yaml) має local image defaults і build contexts | Потрібен checkout/build замість простого pull-only release | D01/D02 |
| [project.sh](../scripts/project.sh) зберігає starter `project:<40sha>` guards; offline init має окрему prepared/unbound identity | Потрібні bound release/storage identity та running-state compatibility checks | D01/D02 |
| [CLI](../docs/CLI.md) має static validators і [offline init](../docs/INSTALLATION_INIT.md) з empty support config/private env; starter [init-env.py](../scripts/init-env.py) лишається окремим | Потрібні installer assembly, doctor/bootstrap, effective deployment config і lifecycle | D02 |
| [backup.sh](../scripts/backup.sh) і helpers орієнтовані на starter/local DB | Support runtime state та external DB потребують recovery contract | D03 |
| [app.ts](../apps/api/src/app.ts) має development Swagger/OpenAPI, route responses покриті нерівномірно | Потрібен повний versioned contract, release spec і SDK | D04 |
| [support/routes.ts](../apps/api/src/modules/support/routes.ts) має polling/clientMessageId, але немає завершеного public events/webhook contract | Host product має самостійно організовувати отримання результату | D05 |
| Reviewed OpenAPI reads/writes/permissions уже реалізовані; legacy MCP лишається read-only | Потрібен reusable authoring kit і спільна перевірка конекторів | D06 |
| Один operator bearer і `operator:staff`; `/team` без invites/roles | Потрібні scoped service identities та customer session lifecycle | D07 |
| Перехід старого Celery/RabbitMQ deployment до Node/BullMQ має перевірений bounded drain; загальний runtime lifecycle ще не визначений | Треба перевірити решту rollout/lease-loss поведінки | D08 |
| DSH lock process-local, native sessions у filesystem | Потрібен явний supported multi-worker storage/ownership contract | D08 |
| Logs/health/audit існують, але немає повного correlated operations contract | Важко діагностувати шлях message → run → tool → effect | D09 |
| `policyContext` читає загальний listCases і окремі proposals; collections непагіновані | Потрібні targeted SQL, bounded reads і вимірювання | D10 |
| Runtime fixture/live synthetic examples не є semantic benchmark | Потрібен dataset і якісні release reports | D11 |
| `sourceRefs` документовано як консервативний snapshot eligible KB; точного transitive provenance ще немає | Потрібні transitive dependencies і source lifecycle tests | D12 |
| [License artifacts/notices](../docs/LICENSING.md), package SPDX, project-scoped image labels і browser notice delivery реалізовані; owner обрав public Docker Hub `latkonazar` | Exact base/native SBOM/source receipts, contributor/media rights, public source route і publication evidence залишаються gates | D13 |
| `AgentModel`/provider config існують, DSH pinned alpha, немає повного verified matrix | Потрібні runtime capability/session/provider contracts | D14 |

Кодова база вже має safeguards. Задачі про authorization, recovery чи limits не слід описувати у release notes як виправлення доведеної vulnerability без окремого підтвердження.

## 4. Поточний CI та deployment: точний висновок

Для прийнятого runtime source [main run 41832367634](https://github.com/LatkoNazar/eldhall/actions/runs/41832367634) завершився успішно на ARM64: `check`, `integration`, `sidecar-compose` і production `deploy`. [Final source run 41831320974](https://github.com/LatkoNazar/eldhall/actions/runs/41831320974) також пройшов усі три mandatory jobs. Конкретні результати: PostgreSQL 29/29, pgvector knowledge 13/13, Python 32/32 та pinned Ruff, cross-language MCP 6/6; standalone Compose реально зібрано, запущено й перевірено з synthetic Orders і scripted model.

Production cutover зупинив старий ingress, дочекався нульових SQL/broker work, зупинив старий worker і перевірив відсутність consumers перед backup/migration. [Post-deployment diagnostics 41834098842](https://github.com/LatkoNazar/eldhall/actions/runs/41834098842) підтвердив `current`/`image.ref` для `2ba80ca`, здорові API/worker/frontend/dependencies, нульові pending RabbitMQ messages і consumers; одна стара queue, broker та storage збережені для rollback. Public readiness, `/operator` і `/chat` повернули 200, integration route без авторизації — 401. Це evidence приватного starter deployment, а не clean install із registry або ввімкненого production business connector.

Пізніші docs/TODO-only commits `5ef349c` і `7728f5d` не змінювали runtime. Їхній [main run 41835023200](https://github.com/LatkoNazar/eldhall/actions/runs/41835023200) для `7728f5d` завершив `check`, `integration`, `sidecar-compose` і production `deploy` успішно. Це історичний checkpoint завершення головного TODO, а не останній source baseline цієї roadmap.

[PR #11](https://github.com/LatkoNazar/eldhall/pull/11) merged як `8f34586375c56358f58566381594fe48ce8d485b`: licensing artifacts, release metadata schema/validator, static CLI та private native candidate workflow. [Standard run 41843288988](https://github.com/LatkoNazar/eldhall/actions/runs/41843288988) і [native run 41843290591](https://github.com/LatkoNazar/eldhall/actions/runs/41843290591) пройшли всі п'ять mandatory jobs. Native AMD64/ARM64 перевірили architecture/non-root/notices, baked CLI identity, DSH/MCP/worker synthetic Orders і UI. Tested merge `7cd5784da3e640830a593e4339d91114df6ab69c` мав той самий Git tree, що reviewed head `d7a6cc055d50e873e60aa200f41e4911f3c761c6`. [Main run 41845904854](https://github.com/LatkoNazar/eldhall/actions/runs/41845904854) для `8f34586` також завершив CI та приватний deploy успішно.

[PR #12](https://github.com/LatkoNazar/eldhall/pull/12) merged як прийнятий `5ae3066`: offline init, installation/request schemas, duplicate-safe non-circular release-signature metadata та private exact-commit source archive. [Standard run 41856018036](https://github.com/LatkoNazar/eldhall/actions/runs/41856018036) завершив усі три mandatory jobs успішно: API 213 tests / 212 passed / 0 failed / 1 pgvector-only skip; окремо PostgreSQL 29/29, knowledge 13/13, Python 32/32 + Ruff, MCP 6/6, host 56, Node 6 і release harness 28. Linux init creation/replay/private modes/partial/symlink/races пройшли; explicit real Compose parser і фактична передача literal env у контейнер — по 1/1 без skips.

[PR12 native run 41856018384](https://github.com/LatkoNazar/eldhall/actions/runs/41856018384) успішно зібрав усі три images на AMD64 та ARM64 із перевіреного source archive exact tested merge `cfdf980be4eae26ea22ed148e5a93eda71e0e50a`. Його tree `282231020ae4737d6424162b12e6e9877e5546f0` дорівнює reviewed head `782111253fd5cab7c69231e6e533a5e2e463ee11` і merged main `5ae3066`. Actual-image offline init перевірив UID 1000, `0700` directory/`0600` files, незмінний replay, explicit synthetic credential sources і `prepared/unbound` без DB/schema epoch claims; DSH/MCP/worker/UI smoke також пройшов. Це private archive rebuild/runtime proof, не public source access або registry pull proof. [Main CI/deploy для `5ae3066`](https://github.com/LatkoNazar/eldhall/actions/runs/41857240322) оцінюється окремо; наведені PR докази не стверджують production rollout цього commit.

Історичний [run 41247159605](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605) на snapshot 1 листопада мав `check: success`, `deploy: failure` на SSH setup. Пізніші спроби [41822733941](https://github.com/LatkoNazar/eldhall/actions/runs/41822733941) зупинилися на missing deployment configuration; її виправили перед успішним rollout. Ці збої не є поточними blockers.

Залишаються gates: фактично published images і перевірка їх digest/provenance/signatures, pull-only clean install без checkout, release/storage binding та runtime schema compatibility, upgrade/restore й незалежний walkthrough. Native AMD64/ARM64 source-build/private archive evidence і авторський production deployment не доводять ці сценарії.

Code CI, trusted release publication і приватний deployment мають окремі результати. Owner підтвердив public `docker.io/latkonazar/eldhall-server`, `eldhall-web`, `eldhall-mcp-openapi` й Apache-2.0 для project-authored code; root LICENSE/NOTICE, package SPDX, scoped image labels і browser notices вже доставляються. Exact Linux base/native inventory, SBOM/corresponding-source receipts, contributor/media rights, public source route й publication evidence лишаються gates. Redis 7.4 та інші third-party компоненти зберігають окремі умови; весь stack не є Apache-2.0. [Distribution contract](../docs/distribution-contract.md), [CLI](../docs/CLI.md) і [init guide](../docs/INSTALLATION_INIT.md) описують реалізовані slices та відкриті release gates, не наявність published images або ready installer.

## 5. Контракти, які треба погодити першими

| Контракт | Основні задачі | Що зафіксувати |
| --- | --- | --- |
| Release identity | D01/D02/D03 | Version, digest, roles, config/schema/runtime compatibility |
| Public API | D04/D05/D07 | Authentication, resources, pagination, error codes, async states |
| Event delivery | D05/D08/D09 | Durable IDs/sequence, retry/replay, authorization і monitoring |
| Connector | Основний TODO/D06/D07 | Manifest, scope, reviewed operations, policy і credentials |
| Execution | Основний TODO/D08/D11 | Claim boundary, unknown, idempotency і truthful result |
| Runtime context | D08/D12/D14 | Native sessions, revisions, provenance, switching/restore |
| Operator/developer docs | D02/D13 | Один перевірений шлях install/integrate/operate |

Взаємні посилання документів означають coordination points. Не створювати штучний цикл, де D01 не починається до повного D02, а D02 — до повного D01: спочатку спільний contract, потім незалежні implementation slices.

## 6. Рівні готовності

### M1 — Installable preview

Придатний для стороннього developer evaluation із чітко описаними межами.

- [ ] Owner license/distribution decision із D13 зафіксований.
- [ ] Versioned images і pull-only bundle доступні у фактичному registry namespace.
- [ ] Заявлені CPU platforms пройшли runnable image smoke.
- [ ] Clean host без repo checkout запускає supported single-worker stack.
- [ ] Init/doctor/config validation дають зрозумілі помилки.
- [ ] Synthetic first case, scoped API example і deterministic action guards перевірені.
- [ ] Документація називає preview status, simulated components та unsupported modes.
- [ ] Існує reproducible offline test path без paid keys.

M1 не є достатнім доказом роботи з реальними критичними даними.

### M2 — Supported self-hosted release

Мета цієї дорожньої карти: інший бізнес може встановити, інтегрувати й експлуатувати сервіс за документацією.

- [ ] Upgrade з попередньої підтримуваної версії та rollback compatibility перевірені.
- [ ] Backup відновлюється на іншому чистому environment; measured RPO/RTO та limits записані.
- [ ] Після restore write execution лишається заблокованим до потрібного reconciliation.
- [ ] Scoped service credentials/customer sessions і authorization matrix пройшли negative tests.
- [ ] Stable API/OpenAPI/SDK, retries/idempotency та polling/event contract відповідають released image.
- [ ] Є щонайменше один host application example і один reference business connector.
- [ ] Runtime crash, broker outage, lease loss, double execute, timeout/unknown та shutdown перевірені на реальних процесах/PostgreSQL.
- [ ] Operations logs/metrics/doctor дозволяють встановити причину збою без розкриття secrets.
- [ ] Default model/runtime має semantic baseline і conformance evidence.
- [ ] Knowledge revoke/update/session behavior перевірений, provenance mode описаний.
- [ ] Capacity profile виміряний; мінімальні ресурси в docs походять із benchmark.
- [ ] Двоє незалежних від core authors розробників пройшли install/integration walkthrough.
- [ ] Немає невирішених release blockers; changelog/support matrix актуальні.

M2 може мати один підтримуваний worker topology і один default provider. Широка матриця платформ/моделей розширюється за evidence.

### M3 — Розширені deployments та ecosystem

Optional growth: multiple runtime adapters, teams/SSO, додаткові channels, scale-out profiles, cloud marketplace/Kubernetes, connector catalog. Кожну capability випускати після її власних conformance і operational tests.

## 7. Мінімальна acceptance матриця релізу

| Сценарій | Середовище | Доказ |
| --- | --- | --- |
| Fresh install | Clean AMD64 і ARM64, якщо обидві заявлені | Image digests, logs, readiness та first-case result |
| External DB | Supported PostgreSQL без доступу до авторського host | Migration scope, TLS/config diagnostics, restore procedure |
| Upgrade | Попередній release + seeded data | Compatibility report, data invariants |
| Rollback | Supported app/schema pair | Success або контрольована відмова з причиною |
| Restore | Новий environment | Backup manifest/hash, recovered state, no blind side effects |
| Host integration | Окремий sample app | SDK/API flow, customer isolation, duplicate input |
| Events | Receiver outage/replay | Stable event identity, retries, no repeated business action |
| Action execution | Ask/auto/deny + possible timeout | Ledger/audit invariants і customer-visible status |
| Knowledge | Revoke/update + warm session | Відсутність stale access та пояснена invalidation |
| Runtime/provider | Default route + fixture failures | Protocol/live evaluation report |
| Capacity | Fixed dataset/hardware/workload | p50/p95, memory/CPU, queue lag, error rates |
| Contribution | Новий contributor checkout | Reproducible tests без private secrets |

## 8. Evidence bundle для кожного release

- [ ] Commit/tag, image index і platform digests, build provenance та dependency inventory.
- [ ] Versioned compose/config/env/OpenAPI artifacts і checksums.
- [ ] Code CI та real integration/process tests reports.
- [ ] Clean-install, upgrade, rollback, restore reports.
- [ ] Quality/capacity reports із fixture/model/hardware details.
- [ ] Supported platform/provider/schema matrix.
- [ ] Known limitations, deprecations і remediation для blockers.
- [ ] Docs version та результати зовнішніх walkthrough.

Reports містять synthetic або дозволені очищені дані; credentials і приватні customer transcripts не публікуються.

## 9. Облік роботи

Task IDs стабільні. Для завершеної задачі додати implementation commit/PR, test/report, docs link і коротку примітку про зміну scope. Blocked task має конкретну залежність і next action.

Публікація цих roadmap файлів не виконує задачі з них. Вони мають залишатися чесним backlog, а не списком уже досягнутих можливостей.

