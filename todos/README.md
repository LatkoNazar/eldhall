# Eldhall — план розвитку після головного TODO

Ця папка містить наступні задачі **після завершеного основного OpenAPI/MCP/permissions плану**. Його історія: [TODO.md на зафіксованому commit](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md), [PR #9](https://github.com/LatkoNazar/eldhall/pull/9), [PR #10](https://github.com/LatkoNazar/eldhall/pull/10), [постійний status/evidence](../docs/STATUS.md). Кореневий TODO видалено в [`7728f5d`](https://github.com/LatkoNazar/eldhall/commit/7728f5d7371e9cbaacb7d77fe3dab9923c52d995).

**Підготовлено:** 2026-11-01; **оновлено:** 2026-11-04.
**Поточний baseline:** `7728f5d7371e9cbaacb7d77fe3dab9923c52d995`; runtime source — `2ba80ca`. Історичні task files зберігають початкову дату; актуальні відмінності й докази — у [D00](00-baseline-and-release-gates.md).
**Статус:** передумова основного TODO виконана; перша хвиля D01/D02/D13 розпочата. Docker Hub publication, clean pull-only install, M1/M2 і SDK ще не підтверджені.

## Мета

Зробити Eldhall звичним для розробника self-hosted компонентом: отримав versioned release, налаштував credentials, запустив, підключив свій backend, бачить стан, може оновити й відновити дані.

Орієнтир Redis/RabbitMQ/Celery тут означає передбачуваний install/config/operate contract, документацію та стабільну інтеграцію. У Eldhall власна топологія: API + worker, PostgreSQL і Redis; optional UI/MCP. Простий запуск не вимагає помістити всі процеси й бази даних в один контейнер.

## Як працювати з цим планом

1. Передумову головного TODO завершено; використовувати його [постійні guides](../docs/OPENAPI_QUICKSTART.md) та [API contracts](../docs/API_CONTRACTS.md).
2. Прочитати [D00: baseline і release gates](00-baseline-and-release-gates.md).
3. Для вибраного напряму перевірити актуальний main: частину прогалин може вже закрити попередня реалізація.
4. Брати конкретний task ID, наприклад `D01-02`, у невелику реалізаційну задачу/PR.
5. Разом із кодом оновлювати tests, docs, compatibility notes та evidence.
6. Ставити checkbox лише після перевірки критерію, додавати commit/PR/report.
7. Завершені плани переносити у history або позначати виконаними після перенесення permanent docs; автоматично видаляти всю папку не потрібно.

Номери файлів — тематичні ідентифікатори, а не сувора черга. Dependencies часто означають узгоджений контракт іншої задачі, а не необхідність завершити весь сусідній документ. Наприклад, image roles D01 і install bundle D02 проектуються разом.

## Поточний облік — 4 листопада

| Slice | Стан і доказ | Що залишається |
| --- | --- | --- |
| Попередній OpenAPI/MCP/permissions етап | Завершено; [main CI/deploy 41832367634](https://github.com/LatkoNazar/eldhall/actions/runs/41832367634), [post-deployment diagnostics](https://github.com/LatkoNazar/eldhall/actions/runs/41834098842) | Бізнесові connector mounts/review/activation лишаються явним deployment кроком |
| D00 refresh | Поточну базу відокремлено від immutable 1 November snapshot у [D00](00-baseline-and-release-gates.md) | Release gates виконуються окремо для кожного candidate |
| D01-01 / D01-02 / D02-01 contract | [Proposed distribution contract](../docs/distribution-contract.md): public namespace, image roles, prerelease, metadata та installation identity | Review, machine schema/validator, CLI, pull-only bundle і published-image evidence; ці task IDs ще не закриті |
| D13-02 owner decision | Owner обрав Apache-2.0 і public Docker Hub images під `latkonazar` | License/attribution inventory, metadata та public source-access evidence перед publication |

Жоден M1/M2 checkbox не позначено на підставі цього документа. Поточний ARM64 source-build/deploy proof не замінює AMD64 native smoke, published-image install або restore report.

## Карта задач

| ID | Напрям | Основний результат | Пріоритет |
| --- | --- | --- | --- |
| [D00](00-baseline-and-release-gates.md) | Baseline та gates | Єдині критерії, коли можна обіцяти підтримуваний реліз | Координація |
| [D01](01-dockerhub-and-release-pipeline.md) | Docker Hub / release | Pull-only images, AMD64/ARM64, version/digest manifest, trusted publication | P0 |
| [D02](02-installation-and-configuration.md) | Встановлення / config | Image-contained init/doctor/bootstrap, clean-host install без checkout | P0 |
| [D03](03-upgrades-backups-and-restore.md) | Upgrade / backup / restore | Сумісні migrations, контрольований rollback і перевірене відновлення | P0 для real data |
| [D04](04-api-contracts-and-sdks.md) | API / SDK | Повний OpenAPI contract, TS/Python SDK, pagination/idempotency | P0 |
| [D05](05-events-webhooks-and-channels.md) | Events / webhooks / channels | Надійне повідомлення host product про результат і reference channel | P1 |
| [D06](06-connectors-and-extension-contracts.md) | Connector authoring | Starter kit, reusable conformance suite, зручні business operations | P1 |
| [D07](07-auth-and-data-isolation.md) | Identity / data lifecycle | Scoped service keys, customer sessions, ізоляція й кероване відкликання | P0 основа, P1 ролі |
| [D08](08-runtime-reliability-and-scaling.md) | Reliability / workers | Bounded drain, recovery, backpressure і перевірена worker topology | P0 |
| [D09](09-observability-and-diagnostics.md) | Logs / metrics / doctor | Зрозуміла причина проблеми без витоку secrets | P0 |
| [D10](10-performance-and-storage.md) | DB / performance | Цільові запити, bounded reads і виміряні resource profiles | P1 |
| [D11](11-agent-quality-and-evaluations.md) | Якість сапорту | Dataset, evaluation reports і semantic regression gates | P0 invariants, P1 якість |
| [D12](12-knowledge-lifecycle-and-provenance.md) | Knowledge lifecycle | Точні dependencies, source revoke/update та versioned indexing | P1 |
| [D13](13-open-source-docs-and-maintenance.md) | OSS / docs / maintenance | License decision, зрозумілі guides, contributor/release process | P0 основа |
| [D14](14-runtime-and-provider-portability.md) | Providers / runtime | Capability contract, verified matrix, контрольована заміна моделей | P0 matrix, P1 adapters |

**P0** — передумови відповідної обіцянки: публічного install, реальних даних або підтримуваного production. **P1** — наступний рівень інтеграції/масштабу/якості. **P2** у файлах — розширення після появи підтвердженої потреби. Пріоритет не є оцінкою тривалості.

## Порядок реалізації

### Хвиля 1 — узгодити контракти й прибрати залежність від приватного deployment

Після головного TODO паралельно зафіксувати image/role contract D01-01, installation/config contract D02, public API D04-01, principal/service-key contract D07-01, lifecycle D08-01 та license decision D13-02. Визначити підтримувані versions і single-worker deployment profile.

**Вихід:** зрозуміло що ставиться, як налаштовується, хто може викликати API і що вважається сумісним.

### Хвиля 2 — дати зовнішньому розробнику працюючий шлях

Реалізувати images/release bundle, init/doctor/bootstrap, scoped host-app example, SDK, logs/health та перші deterministic release checks. Узгодити README/Docker Hub guide з фактичними командами.

**Вихід:** нова людина без коду й доступу до сервера автора запускає release на clean host і проходить synthetic end-to-end case.

### Хвиля 3 — підтвердити експлуатацію з реальними даними

Закрити backup/restore та migrations D03, failure tests D08, diagnostic runbooks D09, SQL/ресурсні вимірювання D10, quality suite D11, source lifecycle D12. Додати events/webhooks D05 і reference connectors D06, коли host integration їх потребує.

**Вихід:** release має evidence не лише для happy path, а й для збою, оновлення, відновлення, відкликання доступу й помилок агента.

### Хвиля 4 — розширювати за попитом

Другий runtime, optional subscription/CLI adapter, SSO, додаткові channels, distributed topology та Kubernetes recipe виконуються після перевірки конкретної потреби. Marketplace, Helm/operator, власний identity provider і великий observability cluster не є стартовими вимогами.

## Що вже є й треба зберегти

Durable PostgreSQL jobs/outbox, fenced leases, окремі approve/execute, payment reservation, `unknown` outcomes, scoped MCP reads, runtime integration tests, backup/release scripts і optional standalone Compose — наявна основа. Задачі деталізують gaps та перевірку її гарантій; вони не пропонують переписувати все з нуля.

Спільне правило: model/runtime/connector convenience не послаблює application policy. Native sessions не замінюють product state, Docker tag не замінює version compatibility, а checkbox не замінює evidence.

## Робота командою

| Потік | Початкові задачі | Контракти, які треба узгодити |
| --- | --- | --- |
| Distribution | D01, D02, D03, частина D13 | Image roles, config/schema versions, release manifest |
| Integrations | D04, D05, D06 | Public DTOs, identities, event envelope, connector contract |
| Runtime/operations | D08, D09, D10 | Lease/drain/admission, telemetry schema, capacity profile |
| Product guarantees | D07, D11, D12, D14 | Authorization, evaluation rubric, provenance, runtime capabilities |

У shared contracts і migrations має бути один відповідальний reviewer на конкретну зміну. Паралельна робота починається з узгоджених interfaces, а не зі спільного редагування всіх core files.

## Загальний Definition of done

- [ ] Завантаження з registry та запуск без local build/checkout перевірені.
- [ ] Host backend інтегрується через stable API/SDK зі scoped credentials.
- [ ] Generic actions зберігають permissions, approval, idempotency та чесні результати.
- [ ] Upgrade/restore/failure сценарії мають відтворюване evidence.
- [ ] Provider, platform і storage support matrix відповідає перевіреним конфігураціям.
- [ ] Є quality/capacity baseline та зрозумілі межі.
- [ ] Постійні інструкції й license/release process готові сторонньому користувачу.
- [ ] Усі заявлені release gates із D00 виконані для відповідного рівня релізу.

Ця папка описує engineering roadmap. Публікація images, зміна visibility/licensing, видання credentials і запуск зовнішніх бізнесових дій виконуються як окремі конкретні задачі, коли для них готові artifacts і рішення owner.

