# D00 — Перевірена база, залежності та критерії релізу

**Дата:** 2026-11-01. **Snapshot:** `858985f38b82e4e26dafb563e4e794ff01cc9196`.  
**Призначення:** дати спільний baseline для всіх планів у `todos/` та не змішувати наявні механізми з майбутніми обіцянками.  
**Попередній етап:** [основний TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md).

## 1. Метод і межі перевірки

План підготовлено за читанням source, deployment scripts, конфігурацій, tests та поточних GitHub Actions results. Під час підготовки цих документів application tests, benchmarks, live models і Docker containers повторно не запускалися. Наявні тести описують перевірювані сценарії; це не твердження про їх новий локальний запуск.

На baseline основний TODO вже записаний у main, але описує запланований OpenAPI/MCP permissions етап. Наступні файли припускають його завершення перед початком реалізації. Після цього потрібно звірити current main і прибрати дублювання вже виконаної роботи.

Знайдені обмеження нижче є engineering gaps або питаннями, які треба перевірити. Наприклад, process-local lock сам по собі не доводить фактичну multi-worker race; для цього потрібні topology contract і process-level tests.

## 2. Наявна інженерна основа

- PostgreSQL зберігає product state; Redis/BullMQ використовується для доставки роботи.
- Приймання повідомлення і durable turn job пов'язані транзакційно; є leases/fences, bounded recovery і finalization.
- Approval відокремлений від execution, прив'язаний до hash; для платежів існує reservation і `unknown` outcome.
- Model-facing tools контролює trusted gateway; scope походить від backend.
- Є runtime tests із реальним DSH та fake model endpoint, MCP transport tests і PostgreSQL integration suites.
- Є standalone support Compose, optional UI і external PostgreSQL recipe.
- Є release/deploy/rollback/backup scripts із чинними guards.
- Є versioned knowledge, retrieval, classifications та Insights.

План продовжує цю основу. Кожна заміна має зберігати її behavioral invariants.

## 3. Карта конкретних прогалин

| Спостереження на baseline | Наслідок для стороннього користувача | Task owner |
| --- | --- | --- |
| [CI](../.github/workflows/ci-cd.yml) збирає images та доставляє release через SSH/docker save | Немає описаного registry-first publication/install contract | D01 |
| [Standalone Compose](../deploy/support.compose.yaml) має local image defaults і build contexts | Потрібен checkout/build замість простого pull-only release | D01/D02 |
| [project.sh](../scripts/project.sh) розбирає `project:<40sha>` image identity | Registry path/digest потребує окремої installation identity | D01/D02 |
| [init-env.py](../scripts/init-env.py) включає starter concerns | Потрібен компактний support-only setup і effective config | D02 |
| [backup.sh](../scripts/backup.sh) і helpers орієнтовані на starter/local DB | Support runtime state та external DB потребують recovery contract | D03 |
| [app.ts](../apps/api/src/app.ts) має development Swagger/OpenAPI, route responses покриті нерівномірно | Потрібен повний versioned contract, release spec і SDK | D04 |
| [support/routes.ts](../apps/api/src/modules/support/routes.ts) має polling/clientMessageId, але немає завершеного public events/webhook contract | Host product має самостійно організовувати отримання результату | D05 |
| MCP integration/tests уже є; головний TODO додає writes/permissions | Потрібен authoring kit і спільна перевірка конекторів | D06 |
| Один operator bearer і `operator:staff`; `/team` без invites/roles | Потрібні scoped service identities та customer session lifecycle | D07 |
| Worker закриває компоненти; загальний bounded drain contract не визначений | Треба перевірити rollout/lease-loss поведінку як одного lifecycle | D08 |
| DSH lock process-local, native sessions у filesystem | Потрібен явний supported multi-worker storage/ownership contract | D08 |
| Logs/health/audit існують, але немає повного correlated operations contract | Важко діагностувати шлях message → run → tool → effect | D09 |
| `policyContext` читає загальний listCases і окремі proposals; collections непагіновані | Потрібні targeted SQL, bounded reads і вимірювання | D10 |
| Runtime fixture/live synthetic examples не є semantic benchmark | Потрібен dataset і якісні release reports | D11 |
| `sourceRefs` консервативно охоплює all eligible KB, docs говорять про retrieved | Потрібні transitive dependencies і узгоджена документація | D12 |
| Немає root LICENSE, README змішує product і starter, CLAUDE містить старі правила | Потрібні owner decisions, onboarding і maintenance process | D13 |
| `AgentModel`/provider config існують, DSH pinned alpha, немає повного verified matrix | Потрібні runtime capability/session/provider contracts | D14 |

Кодова база вже має safeguards. Задачі про authorization, recovery чи limits не слід описувати у release notes як виправлення доведеної vulnerability без окремого підтвердження.

## 4. Поточний CI: точний висновок

Для baseline commit перевірено [run 41247159605](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605):

- [`check` — success](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605/job/124672861754).
- [`deploy` — failure](https://github.com/LatkoNazar/eldhall/actions/runs/41247159605/job/124673960286) на `Configure verified SSH connection`.

Отже, червоний загальний run не означає падіння тестів. Зі статусу кроку не встановлена точна внутрішня причина SSH-збою.

Окремі coverage gaps у workflow:

- `npm test` запускає `tests/*.test.ts`; real PostgreSQL suites мають окремий `test:postgres`, який не викликається workflow.
- Standalone support Compose перевіряється через parsing; container smoke орієнтований на starter recipe.
- Published multi-platform registry image, pull-only installation, upgrade та restore не мають end-user release gates.

Після D01 розділити code CI, trusted release publication і конкретний приватний deployment. Збій авторського SSH host не повинен робити сторонній OSS release нерозбірливим.

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

