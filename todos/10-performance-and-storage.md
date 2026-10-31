# D10 — Продуктивність, запити до БД і ресурсні межі

**Пріоритет:** P1; виміряний capacity profile потрібен до рекомендацій production sizing.  
**Передумови:** основний [TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md); коректні claims із [D08](08-runtime-reliability-and-scaling.md), базові вимірювання з [D09](09-observability-and-diagnostics.md). Pagination contract узгодити з [D04](04-api-contracts-and-sdks.md).  
**Результат:** відтворювані measurements, усунуті підтверджені зайві scans і зрозумілі межі CPU/RAM/storage для підтримуваних deployment profiles.

## 1. Що справді видно у коді

Перевірено commit `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01. Тут описаний статичний аналіз, а не результати навантажувального тесту.

| Спостереження | Джерело | Практичне питання |
| --- | --- | --- |
| `policyContext()` читає всі cases, фільтрує клієнта, потім окремо завантажує proposals кожного case | [harness.ts](../apps/api/src/modules/agent/harness.ts) | Чи можна отримати потрібний customer-wide policy state одним цільовим запитом? |
| `listCases()` і `messages(caseId)` не мають pagination | [postgres-store.ts](../apps/api/src/modules/support/postgres-store.ts) | Як обмежити response, DB work та RAM на великих історіях? |
| Pool має `max: 10` у кожному process | [database.ts](../apps/api/src/core/database.ts) | Скільки connections реально створює весь deployment із replicas? |
| Retrieval спершу індексує/збирає chunks усіх eligible documents, потім ранжує | [retriever.ts](../apps/api/src/modules/knowledge/retriever.ts) | Яка ціна cold/warm search при великій KB? |
| Cache обмежений `MAX_CACHED_DOCS = 5000`, але ліміт визначений кількістю документів | [retriever.ts](../apps/api/src/modules/knowledge/retriever.ts) | Які memory bytes при різному розмірі document/chunks/vector dimensions? |
| Кожен DSH run створює gateway/runtime; native sessions мають persistent files | [dsh-model.ts](../apps/api/src/runtime/dsh-model.ts), [profile.ts](../apps/api/src/runtime/profile.ts) | Який startup overhead, disk growth і RSS на одночасний turn? |
| Dashboard metrics використовують aggregate queries за історією | [postgres-store.ts](../apps/api/src/modules/support/postgres-store.ts) | Як часто їх можна обчислювати без впливу на chat/actions? |

Уже є timeout, output limits, bounded model history, cache eviction і pgvector support. Не називати їх відсутніми. Наявність описаних patterns не доводить, що система зараз повільна; спершу виміряти.

## 2. Задачі

### D10-01 — Відтворюваний baseline

- [ ] Створити deterministic synthetic dataset generator: business/customer/cases, різна довжина історій, proposals у різних станах, KB різних розмірів. Seed і distributions зберігати у benchmark manifest.
- [ ] Відокремити два режими: infrastructure benchmark із deterministic model/upstream fixture і обмежений live-model evaluation. Результати не змішувати.
- [ ] Для кожного запуску зберігати git SHA/image digest, architecture, vCPU/RAM, container limits, Node/PG versions, workers/concurrency, provider fixture delay, DB row counts і KB corpus size.
- [ ] Вимірювати cold start, warm request, accepted-turn latency, queue wait, model initialization/run, tool duration, DB queries/pool wait, p50/p95/p99, throughput, errors, RSS/heap/CPU/disk.
- [ ] Перевірити ARM64 та AMD64 на доступному hardware. Профіль на кшталт ARM64 2 vCPU/12 GB може бути початковою тестовою конфігурацією, але не оголошеним мінімумом до вимірювань.
- [ ] Повторювати достатньо запусків для оцінки розкиду; warmup і cache state фіксувати. Один швидкий run не є capacity guarantee.

### D10-02 — Усунути глобальний scan у policyContext

- [ ] Додати цільовий store method для потрібного customer/business policy state, наприклад `policyProposalsForCustomer(customerId, statuses)`.
- [ ] Виконувати фільтрування scope і релевантних status у SQL через join proposals → cases; не витягати всі бізнеси в Node.
- [ ] Уточнити точний набір даних, потрібний кожному guard. Для refund зберегти customer-wide захист від дубля між різними cases і payment reservation.
- [ ] При final execution перевіряти актуальний стан у межах existing claim/policy semantics; оптимізація не повинна перетворити перевірку на застарілий cache.
- [ ] Додати regression на query count і fixtures з великою кількістю чужих cases. Обсяг роботи для одного клієнта не має лінійно залежати від усіх cases deployment.
- [ ] Порівняти SQL plans і фактичний результат до/після; зберегти сценарій concurrent proposals із D08.

### D10-03 — Pagination та bounded reads

- [ ] Запровадити bounded list methods для cases, messages, proposals, audit та runs, починаючи з API шляхів, які фактично читають повні історії.
- [ ] Узгодити з D04 opaque cursor, максимальний page size, ordering і scope validation. Cursor не є дозволом доступу.
- [ ] Для незмінних історичних записів використовувати keyset за `(created_at, id)`; для inbox ordering за priority/updated_at явно описати live semantics при переміщенні записів між сторінками.
- [ ] Не обіцяти ідеальний snapshot для mutable inbox без відповідної реалізації. UI може дедуплікувати за ID і refresh поточне вікно; строгий export потребує окремої snapshot процедури.
- [ ] Окремий метод читання останнього bounded контексту для harness не має завантажувати всю історію лише щоб потім зробити `slice(-10)`.
- [ ] Source visibility/revocation і customer ownership перевіряються для кожної сторінки. Pagination не повинна пропустити ці filters.
- [ ] Сумісність із старими clients оформити в API version/deprecation policy; не мовчки змінювати масив на paginated object.

### D10-04 — Індекси й pool budget

- [ ] Зібрати actual hot queries і використати `EXPLAIN (ANALYZE, BUFFERS)` на synthetic representative data. Пам'ятати, що `ANALYZE` виконує запит; mutations досліджувати тільки на тестовому наборі.
- [ ] Перевірити candidate indexes для cases за customer/business, active proposals та queue eligibility; додавати лише індекси з підтвердженим query pattern.
- [ ] Врахувати write amplification, table size, selectivity, sort order та statistics. Відсутність index scan на маленькій таблиці сама по собі не є помилкою.
- [ ] Переглянути compound indexes для pagination і queue polling; не створювати дублікати наявних [0002](../apps/api/migrations/0002_support.sql)/[0003](../apps/api/migrations/0003_support_turns.sql) indexes.
- [ ] Додати bounded pool settings за роллю і задокументувати total budget: API replicas + worker replicas + migrations + diagnostics мають вкладатися в PostgreSQL connection limit із резервом.
- [ ] Виміряти pool acquisition wait; підвищення `max` не є автоматичним виправленням повільного SQL.
- [ ] Налаштування statement/query/connection timeout зберегти узгодженими з run deadline. Міграції індексів перевірити за upgrade contract D03.

[Документація PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) — довідка для аналізу плану; кінцеві рішення обґрунтовуються вимірами саме цих queries і підтримуваної версії БД.

### D10-05 — Retrieval, indexing і bounded memory

- [ ] Окремо виміряти local hashing, persisted pgvector і зовнішній knowledge connector. Вони мають різні cold/warm витрати.
- [ ] Додати cache byte/entry metrics і обмеження сумарного memory budget; чинний document-count limit зберегти або замінити з explicit migration поведінкою.
- [ ] Обмежити паралельне embedding/indexing. `Promise.all` над усіма документами не повинен створити неконтрольований burst provider calls або RAM.
- [ ] Для production KB винести попередню підготовку embeddings на publish/reindex job із revision-aware status; lazy indexing лишити bounded fallback.
- [ ] Розглянути SQL/vector/lexical candidate retrieval до materialization всіх chunks, якщо benchmark доводить користь. Зберегти audience/plan/business filters і перевірку версій результатів.
- [ ] Cold cache stampede: одночасні turns одного deployment не мають повторно будувати той самий document/version index без координації.
- [ ] Embedding outage має давати відомий lexical fallback і метрики, не необмежений повтор indexing на кожному запиті.
- [ ] Якість retrieval і точну provenance перевіряти разом із D11/D12; прискорення не виправдовує повернення приватних або застарілих passages.

### D10-06 — Runtime overhead і життєвий цикл sessions

- [ ] Розкласти час turn на profile preparation, process startup, session resume, model call, tools, persistence і close. Порівняти cold/warm sessions.
- [ ] Виміряти parent + child RSS при concurrency 1, 2 та наступних значеннях у межах ресурсу; перевірити повернення пам'яті після закриття.
- [ ] Додати disk usage та bounded cleanup native sessions/checkpoints. Видаляти тільки неактивні artifacts після retention policy, сумісної з D03/D07/D12.
- [ ] Перевірити session identity при model/runtime/policy revision change. Старий incompatible session не має реанімуватися через optimization cache.
- [ ] Лише за виміряної користі розглядати runtime reuse або connection pooling. Критерії: ізоляція credentials/context, cancellation, reconnect, manifest revision і відсутність cross-business state.
- [ ] MCP connection reuse так само є окремим експериментом. Чинні short-lived connections не називати дефектом без порівняння latency/resource cost.
- [ ] Якщо native session growth дає суттєву ціну, протестувати bounded verified-history режим з D14 і quality suite; не оголошувати його еквівалентним за пам'яттю без оцінювання.

### D10-07 — Історія, aggregates і retention

- [ ] Виміряти scans dashboard metrics, кількість рядків audit/runs/messages та темп їх зростання.
- [ ] Запровадити configurable retention для технічних attempts/log metadata з dry-run, batching і watermark. Бізнесовий audit/action ledger видаляти лише за окремою політикою D07.
- [ ] Якщо потрібні incremental aggregates, залишити процедуру reconciliation із source tables та версію агрегатора. Cached counters не повинні видаватися за точні після часткового відновлення.
- [ ] Cleanup jobs мають малі транзакції, resumable progress і обмеження навантаження; не блокувати live claims довгим DELETE.
- [ ] Partitioning або окреме аналітичне сховище вводити лише після виміряного масштабу. PostgreSQL залишається достатньою першою ціллю цього плану.

## 3. Матриця benchmark

| Вимір | Сценарії | Що порівнювати |
| --- | --- | --- |
| Розмір БД | Кілька seed scales; багато чужих cases; довга історія одного клієнта | Query count, plan, pool wait, response bytes |
| KB | Cold/warm cache, короткі/довгі документи, нова revision | Index/search latency, embedding calls, RSS, якість hits |
| Runtime | Новий session, resume, policy revision, retry attempt | Startup/run/close time, parent+child memory |
| Навантаження | Рівний потік, burst, noisy business, provider slowdown | Queue age, throughput, rejection/failure rate, fairness |
| Життєвий цикл | Тривалий контрольований soak, restart, cleanup | Стабільність RSS/disk, коректність recovery, leaks |

Порівняння оптимізацій проводити на тих самих fixtures і ресурсах. Публікувати не тільки найкращий результат, а діапазон, failures і фактичні config limits. Live-model pricing/latency фіксуються з датою та provider metadata; їх не використовувати як гарантію системної продуктивності.

## 4. File map і deliverables

Змінювати за результатами вимірів: `modules/agent/harness.ts`, `modules/support/store.ts`, `postgres-store.ts`, `postgres-turn-jobs.ts`, `routes.ts`, `core/database.ts`, `core/config.ts`, `modules/knowledge/retriever.ts`, `vector-store.ts`, `runtime/dsh-model.ts`, `profile.ts`. Нові benchmark/fixture scripts розмістити окремо від production boot; індекси — у наступних migrations.

Deliverables: `docs/performance/` із methodology, reproducible commands, dataset manifest, raw machine-readable results, capacity table та рекомендаціями. Не комітити production data, API keys або необмежені heap dumps. Мінімальний CI gate — targeted query regression і bounded smoke; довгі soak/live runs запускаються окремо з контрольованим бюджетом.

## 5. Definition of done

- [ ] `policyContext` більше не сканує всі cases deployment і не робить N запитів за кількістю cases клієнта.
- [ ] Public list/history endpoints і model context мають явні bounded read contracts.
- [ ] Є documented total DB connection budget і перевірка конфігурації при replica growth.
- [ ] Відомі cold/warm overhead, peak RSS і storage growth для підтримуваного profile.
- [ ] Тривалий тест не показує необмежене зростання процесних cache/session resources за фіксованого bounded workload.
- [ ] Performance changes проходять correctness, scope/revocation і duplicate-effect regressions.
- [ ] Capacity table містить виміряні умови, а не універсальну обіцянку RPS; SLO thresholds із D09 спираються на ці дані.
- [ ] Постійні результати перенесені в документацію й прив'язані до image digest; невдалі optimization experiments теж мають короткий запис причин.
