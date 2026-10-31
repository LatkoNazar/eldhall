# D03 — Оновлення, backup, rollback і відновлення після збою

**Пріоритет:** P0 перед використанням реальних бізнесових даних та зовнішніх write actions.  
**Передумови:** завершений [основний TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md), release manifest із [D01](01-dockerhub-and-release-pipeline.md), installation identity/config із [D02](02-installation-and-configuration.md).  
**Результат:** підтримуваний реліз можна оновити, перевірити, відкотити в межах сумісності та відновити на іншому host із контрольованим станом зовнішніх дій.  
**Baseline:** commit `858985f38b82e4e26dafb563e4e794ff01cc9196`.

## 1. Наявні гарантії, які треба зберегти

[deploy.sh](../scripts/deploy.sh) уже використовує deployment lock, перевіряє project identity, створює pre-deploy PostgreSQL dump, запускає migration і smoke, зберігає current/previous release. При помилці намагається повернути попередній application image та прямо попереджає, що migrations автоматично не скасовуються.

[rollback.sh](../scripts/rollback.sh) є application-only rollback; дані й schema не відкочуються. [backup.sh](../scripts/backup.sh) робить PostgreSQL custom-format dump і окремий Umami dump, коли analytics присутня. Він перевіряє, що файл непорожній.

Ці helpers прив'язані до root starter Compose/local PostgreSQL. [Implementation guide](../docs/implementation.md) явно відокремлює їх від external `DATABASE_URL` і рекомендує backup DSH home, але `backup.sh` не створює копію native runtime sessions. Процедуру відновлення standalone support installation потрібно допрацювати.

[Support migration runner](../apps/api/src/modules/support/migrations.ts) уже має transaction та advisory lock, але виконує перелік SQL scripts повторно; [migrate.ts](../apps/api/src/migrate.ts) друкує загальну назву support v1. Для release compatibility потрібні точні schema revision/checksums, а не лише успішний startup.

## 2. Розділити чотири операції

| Операція | Що змінюється | Що треба перевірити |
| --- | --- | --- |
| Application upgrade | Image/config та, за потреби, schema | Сумісність нового коду, migration і поточних даних |
| Application rollback | Попередні images/config | Чи попередній код читає поточну schema/нові записи |
| Backup | Створюється перевірений recovery artifact | Повнота, consistency boundary, можливість restore |
| Disaster restore | Дані повертаються до recovery point | Втрачені записи після backup, зовнішні effects, replay |

Заміна image tag не є відновленням даних. Відновлення старої БД не скасовує вже зроблене повернення коштів, зміну замовлення або надісланий webhook.

### D03-01 — Версії schema і migration contract

- [ ] Для наявної installation без нового migration ledger реалізувати explicit adoption: звірити historical schema baseline і compatibility, тоді записати доведені applied revisions/checksums. Існування таблиць не означає виконання всіх migrations; scripts не перезапускаються наосліп.

- [ ] Додати migration ledger із revision, checksum, applied timestamp і source release.
- [ ] Зберегти advisory locking та transactional застосування там, де SQL це підтримує.
- [ ] Уже застосований script із іншим checksum має зупиняти migration з поясненням, а не мовчки виконуватись повторно.
- [ ] Зафіксувати supported upgrade paths і range schema, з яким працює кожний image.
- [ ] Перед стартом API/worker відхиляти unsupported old/new schema з actionable message.
- [ ] Maintenance release notes називають точну migration, очікувані locks, додатковий disk space і rollback compatibility.
- [ ] Обрати expand/contract: спочатку additive schema і сумісний код; backfill окремим resumable кроком; видалення старих полів лише після завершення support window.
- [ ] Великі backfills виконувати batch-ами з progress/checkpoint; не тримати довгу глобальну transaction без потреби.
- [ ] Migration із DDL, несумісним із transaction, має окремий контрольований сценарій, а не автоматичне вимкнення transactions для всіх migrations.
- [ ] Підтвердити upgrade через потрібні проміжні версії; не обіцяти довільний jump між усіма релізами.

### D03-02 — Preflight і controlled upgrade

- [ ] Ввести upgrade plan: current/target release, schema delta, required restart, backup status, disk/architecture/config compatibility.
- [ ] Отримати та перевірити всі image digests до початку service disruption.
- [ ] Захистити installation від одночасних upgrade, restore, rollback і backup-with-quiescence через спільний operation lock, що координує адміністраторів на різних hosts. Для external DB/multi-host потрібен installation-scoped DB lock/lease з fencing; local filesystem lock недостатній. Довгі зовнішні дії не тримають відкриту SQL transaction.
- [ ] На maintenance window призупинити нові mutations/execute; клієнти отримують явний retriable status із request identity.
- [ ] Дати active turns/executions bounded drain. Недостатньо зупинити нові messages, якщо окремий approve/execute endpoint продовжує dispatch.
- [ ] Після закінчення grace period класифікувати interrupted work за фактичним станом; можливий remote effect не переводити у «нічого не сталося».
- [ ] Створити перевірений pre-upgrade recovery point, застосувати migrations і запустити нові processes.
- [ ] Виконати readiness та synthetic support smoke без реальних business writes.
- [ ] Оновити current release pointer лише після успішного smoke; previous release metadata зберегти.
- [ ] Upgrade не видаляє Docker volumes і не обирає новий project name.

### D03-03 — Application rollback із перевіркою сумісності

- [ ] Зафіксувати в manifest `rollbackCompatibleTo` або рівнозначний перевірюваний контракт.
- [ ] Автоматичний rollback застосовувати тільки коли старий image сумісний із поточною schema/config і новими форматами даних.
- [ ] Якщо destructive migration зробила rollback несумісним, зупинитися в maintenance state із планом roll-forward або explicit restore.
- [ ] Ніколи не запускати reverse SQL наосліп при failed healthcheck.
- [ ] Rollback не вмикає старі permissions, відкликані credentials або застарілі pending approvals.
- [ ] Перевіряти compatibility manifest Python sidecar, native runtime session format і model adapter разом із server version.
- [ ] Зберегти нинішній принцип: повернення старої програми саме по собі не відновлює стару БД.
- [ ] Провал самого rollback має залишати діагностику й стабільний maintenance state, а не нескінченне чергування images.

### D03-04 — Повний backup manifest

Для одного recovery point описати всі джерела:

| Джерело | Роль | Стратегія |
| --- | --- | --- |
| PostgreSQL | Messages, jobs, policies, approvals, actions, audit, KB | Consistent dump або підтримуваний provider backup |
| Versioned config/manifests | Визначення deployment і integrations | Копія immutable artifacts + checksums |
| DSH runtime home | Native sessions/checkpoints | Узгоджена копія після quiescence або перевірена процедура rebuild |
| Redis | Delivery/cache state | Визначена політика відновлення/rebuild з authoritative PostgreSQL |
| External KB/storage | Документи/індекси за конфігурацією | Перелік owners, backup або documented reindex |
| Credentials | Доступ до залежностей | Окремий захищений recovery процес, не public bundle |

- [ ] Для кожного backup записувати installation ID, release digests, schema/config revisions, timestamps, hashes, component list і consistency mode.
- [ ] PostgreSQL dump є internally consistent snapshot БД, але не спільною транзакцією з DSH files чи зовнішнім API; цей boundary вказати явно.
- [ ] Для простого first release quiesce application writes на час узгодження state; далі можна додати перевірений online backup flow.
- [ ] Не копіювати відкриті runtime session files як гарантовано консистентний backup.
- [ ] Якщо sessions вважаються rebuildable, довести це тестом із canonical product history і dispatcher: rebuild не відтворює старі side effects.
- [ ] Писати backup у temporary artifact; фіналізувати manifest тільки після перевірок усіх обов'язкових components.
- [ ] Перевіряти exit status, checksum, archive structure та restoreability; `test -s` недостатньо.
- [ ] Врахувати database roles/extensions/ownership. App schema export не є автоматично backup усіх cluster-level objects.
- [ ] Для external DB підтримати provider-native snapshot або remote client path із правильними privileges, TLS і tool/server version compatibility.
- [ ] Вивести scheduler-neutral backup command: користувач може запускати через cron/systemd/свій orchestrator.
- [ ] Retention, encryption, off-host copy та доступ до recovery keys мають бути explicit deployment settings. Перевірений локальний dump на тому самому disk не покриває втрату host.

[PostgreSQL SQL dump documentation](https://www.postgresql.org/docs/17/backup-dump.html) описує snapshot і restore; [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) — формати, privileges та версійну сумісність. У задачі потрібен application-level recovery contract поверх цих механізмів.

### D03-05 — Restore у безпечному стані

- [ ] Restore target має бути новим/порожнім installation або explicit підтвердженою заміною конкретного deployment. Перевірити identity до destructive writes.
- [ ] Спочатку валідувати manifest/checksums/image availability і достатність disk space.
- [ ] Відновлювати БД, потрібні artifacts і узгоджений runtime state у відключеному execution mode.
- [ ] До resume відокремити старий і відновлений deployment: зупинити/revoke старі writers, перевірити installation epoch і доступ до upstream. Якщо fencing недоступного старого host не доведено, mutations лишаються вимкненими.
- [ ] Restored pending/approved authorizations за замовчуванням інвалідувати. Перед mutations перевірити актуальні connector permissions, reviewed manifests, credential revocations і deletion watermarks, що могли змінитися після backup recovery point.
- [ ] Відновлення не стартує broker consumers, external write tools або outbound webhooks автоматично.
- [ ] Визначити долю queued/running jobs, leases, fences та broker messages. Старий Redis job не стає новим повноваженням на effect.
- [ ] БД відновлюється до певного моменту: downstream effect, виконаний пізніше, може бути відсутнім у локальному ledger.
- [ ] До resume перевірити external actions після recovery point за provider references/idempotency keys, external audit або ручною reconciliation.
- [ ] Якщо повний список effect неможливо встановити, тримати відповідні write integrations вимкненими; не називати restore повністю безпечним для автоматичного dispatch.
- [ ] Native session не має авторитету над відновленою policy/approval. Старі модельні calls проходять актуальний dispatcher.
- [ ] Secrets відновити/перевидати через захищений channel; invalid customer/operator sessions обробити за auth policy.
- [ ] Після validation запустити API read path, потім controlled worker processing, після reconciliation — дозволені mutations.
- [ ] Completion/recovery messages дедуплікувати, щоб restart не надсилав клієнту повторні відповіді.

### D03-06 — Restore drills та вимірювані гарантії

- [ ] Створити synthetic dataset із knowledge, histories, active/pending/approved/unknown actions, queued turns та versioned integrations.
- [ ] Backup → fresh-host restore → schema checks → representative reads → one controlled new turn.
- [ ] Перевірити недоступний artifact, corrupted dump, missing secret, іншу архітектуру, partial backup і стару schema.
- [ ] Відтворити «upstream action succeeded, response lost, DB restored to earlier point» і підтвердити відсутність blind redispatch.
- [ ] Перевірити simultaneous migration runners, failed migration і restart посеред resumable backfill.
- [ ] Відтворити одночасно доступний старий host та restored clone; лише fenced активна installation може виконувати writes. Окремо перевірити, що backup не відновлює відкликане approval або credential.
- [ ] Показати actual RPO/RTO на відомому dataset/hardware. Цільові значення затвердити після baseline, не називати їх SLA без доказу.
- [ ] Зберігати останній успішний drill report, release versions, duration, data counts і відомі exclusions.
- [ ] Визначити повторення drill при змінах schema/runtime/backup format і перед stable release.

## 3. Файли й порядок реалізації

Модифікувати `scripts/release.sh`/`deploy.sh`/`rollback.sh`/`backup.sh` або перенести підтримувані гарантії в image CLI із D02. Створити support-specific adapters для bundled та external PostgreSQL. Розширити migration metadata, release manifest, maintenance/drain controls і recovery documentation.

Порядок: schema compatibility contract → controlled upgrade/rollback → backup manifest → isolated restore → external-effect reconciliation → fault drills. Власний managed backup service, PITR infrastructure та автоматична підтримка кожного cloud provider не є першою умовою; інтеграційні контракти мають дозволяти їх додати.

## 4. Definition of Done

- [ ] Наявний deployment оновлюється до наступного підтримуваного релізу з перевіреним recovery point.
- [ ] Сумісний application rollback працює; несумісний чесно відхиляється.
- [ ] Backup включає або явно виключає з поясненням кожне authoritative/rebuildable джерело.
- [ ] Restore на чистий host пройшов із конкретними evidence, а не лише успішним `pg_dump`.
- [ ] Зовнішня action після старого recovery point не повторюється без reconciliation.
- [ ] Runtime sessions, policies, approvals і queue state після restore мають узгоджений trust model.
- [ ] Є операторська інструкція для upgrade failure, corrupted backup і unknown execution.
- [ ] Release gate перевіряє принаймні попередній підтримуваний release → candidate upgrade та documented rollback path.

