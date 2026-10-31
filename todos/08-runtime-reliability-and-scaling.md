# D08 — Надійність runtime, завершення процесів і масштабування worker

**Пріоритет:** P0 перед заявою про production-ready deployment.  
**Передумова:** реалізований основний [план OpenAPI / permissions / execution](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md); узгоджений deployment contract із [D02](02-installation-and-configuration.md).  
**Результат:** задокументований і перевірений спосіб запуску одного та кількох worker, зупинки, recovery і роботи під перевантаженням.  
**Статус:** план; наведені гарантії потрібно підтвердити тестами реалізації.

## 1. На що спираємося

База перевірки — commit `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01. Зараз уже є важливі механізми:

- [PostgresTurnJobs](../apps/api/src/modules/support/postgres-turn-jobs.ts) атомарно записує повідомлення і turn job, перевіряє `clientMessageId`, захоплює job із `fence`, `workerId`, ownership version і lease; recovery обмежений трьома claims.
- [turn-queue.ts](../apps/api/src/modules/support/turn-queue.ts) повторно публікує PostgreSQL outbox у BullMQ; брокер не є єдиним записом прийнятого звернення. [turn-processor.ts](../apps/api/src/modules/support/turn-processor.ts) поновлює lease та звільняє turn.
- [PostgresSupportStore](../apps/api/src/modules/support/postgres-store.ts) перевіряє lease при завершенні turn; payment executions резервуються; interrupted execution отримує `unknown`.
- [support-queue.test.ts](../apps/api/tests/support-queue.test.ts), [postgres-store.integration.ts](../apps/api/tests/postgres-store.integration.ts) і [runtime.test.ts](../apps/api/tests/runtime.test.ts) вже перевіряють redelivery, ownership, recovery та закриття DSH child. Їх слід розвивати, а не дублювати новою чергою.

Конкретні місця для доробки: [worker.ts](../apps/api/src/worker.ts) послідовно очікує закриття компонентів без одного загального drain deadline; [rate-limit.ts](../apps/api/src/modules/support/rate-limit.ts) прямо визначає limiter як per-process; [dsh-model.ts](../apps/api/src/runtime/dsh-model.ts) має process-local `activeConversations`, а [profile.ts](../apps/api/src/runtime/profile.ts) зберігає native sessions у файловій системі. Це не доводить наявність race у production, але підтримуваний multi-worker контракт ще треба визначити й перевірити.

## 2. Контракт експлуатації

PostgreSQL залишається джерелом стану звернення, claim та effect ledger. Redis/BullMQ доставляє роботу, яка може надійти повторно. Збережене `202 Accepted` означає, що звернення має durable запис; це не обіцянка, що модель уже виконала turn. `unknown` залишається окремим від `failed` і `cancelled`.

Перший підтримуваний production profile — один deployment, PostgreSQL, Redis, окремі API і worker. Кілька worker на одному host оголошувати підтримуваними після відповідних тестів. Multi-host native-session continuity — окремий compatibility gate; проста команда `--scale worker=3` не доводить її коректність.

| Подія | Очікувана поведінка |
| --- | --- |
| Повтор delivery того самого run | Знайти існуючий durable job/action; не створювати другий effect |
| Втрата lease | Заблокувати нові tools і фінальний stale commit, завершити runtime attempt |
| SIGTERM | Припинити нові claims, дати bounded час завершити роботу, потім зупинити активні attempts |
| Redis недоступний | Зберегти прийнятий outbox; поновити доставку після recovery згідно admission limits |
| PostgreSQL недоступний | Не підтверджувати незбережені звернення; не виконувати нові business effects |
| Timeout після можливого external write | Зберегти `unknown` і шлях reconciliation; не робити blind retry |

## 3. Задачі

### D08-01 — Єдиний lifecycle процесу

- [ ] Додати явні стани `starting`, `ready`, `draining`, `stopped` для API та worker; health і logs мають відображати їх.
- [ ] Створити спільний shutdown coordinator із повторно безпечним `close()`, bounded deadline та per-component результатами. Значення deadline — deployment setting з валідацією.
- [ ] На SIGTERM спочатку закрити admission/нові claims, зупинити relay polling, потім очікувати активні jobs, runtime children і persistence finalizers.
- [ ] Після drain deadline abort активні model attempts; зберегти можливість fenced recovery. Закрити Redis/DB лише після спроби зафіксувати результати.
- [ ] Узгодити deadline з Docker `stop_grace_period`. Не розраховувати лише на `worker.close()`: за [документацією BullMQ](https://docs.bullmq.io/guide/workers/graceful-shutdown) TypeScript shutdown очікує active jobs без власного timeout.
- [ ] Не відмічати вже dispatched write як скасований тільки через завершення model process. Його ledger завершується незалежно від turn lease за правилами головного TODO.

### D08-02 — Втрата lease й recovery

- [ ] Перевірити шлях `heartbeatTurnJob() === false`: runtime має дізнатися про втрату lease й завершитися, а не лише дочекатися чергової перевірки перед tool call.
- [ ] Відрізняти тимчасову помилку heartbeat від підтвердженої втрати ownership; жоден випадок не дозволяє роботу після deadline чинного lease.
- [ ] Зберігати bounded recovery budget у PostgreSQL. Кількість retries у BullMQ, SDK і provider не повинна множитися непомітно.
- [ ] Дати оператору діагностований terminal failure із reason code після вичерпання attempts; manual retry створює контрольований новий run і не повторює старий effect.
- [ ] Зафіксувати порядок блокувань case/job/action rows і дотримуватися його в takeover, execute та recovery, щоб уникнути циклічного очікування.

### D08-03 — Native sessions і кілька процесів

- [ ] Описати ADR: хто володіє session files, які каталоги можуть змінюватися одночасно та що відбувається після worker crash.
- [ ] Прив'язати mutable attempt workspace до business/case/context revision і durable fence. Старий process не повинен змінювати workspace новішого attempt.
- [ ] Для повторного використання checkpoint приймати лише сумісний завершений snapshot; pointer на нього оновлювати після закриття writer і успішної перевірки fence.
- [ ] Process-local `activeConversations` залишити локальним додатковим guard; він не замінює міжпроцесний ownership.
- [ ] Перший multi-host варіант має або доведений session backend, або явний режим відновлення з verified product history без обіцянки перенесення повної native memory. Перевірити якість останнього через D11.
- [ ] Не оголошувати довільний shared/NFS volume безпечним автоматично. Перевірити atomic file update, stale writer, restart і runtime-version mismatch на підтримуваному сховищі.
- [ ] При зміні policy/manifest/knowledge revision не відновлювати session зі старими правами. Розширити наявний context revision полями головного TODO.

### D08-04 — Admission, backpressure і справедливість

- [ ] Ввести явні limits: active model turns на instance, queued turns на business/deployment, максимальний queue age і concurrent connector calls.
- [ ] Перевіряти межі до durable acceptance; відмову повертати з machine-readable reason і `Retry-After`, узгодженими з D04.
- [ ] Уже прийняті jobs не видаляти при досягненні ліміту. Вони мають завершитися, перейти оператору або отримати явний terminal outcome.
- [ ] Для кількох API замінити per-process limiter на shared limiter із задокументованим режимом під час недоступності його сховища. Окремо захистити unauthenticated traffic і authenticated customer/business quotas.
- [ ] Підтримати per-business concurrency/fair admission без нової обов'язкової брокерної платформи. Навантаження одного бізнесу не має безстроково витісняти інші.
- [ ] Співвіднести concurrency support turns, starter jobs та insights із загальним memory/provider budget: один `WORKER_CONCURRENCY` зараз не описує весь паралелізм процесу.

### D08-05 — Транзитні збої без retry storm

- [ ] Класифікувати retryable dependency/model failures, invalid input, permission denial і unknown effect окремими reason codes.
- [ ] Для безпечних повторів додати bounded backoff із jitter і загальним run deadline; effectful retries дозволяє лише adapter contract.
- [ ] Redis outage/reconnect не має запускати необмежений цикл log spam, повторних publish або створення connections.
- [ ] Зберегти outbox reconciliation batch; виміряти час обходу й дубльовану публікацію при кількох relay. Оптимізувати claim/publish coordination лише якщо це підтверджене вузьке місце.
- [ ] Додати shutdown під час DB outage: жодної фальшивої заяви про завершення; наступний startup відновлює стан за durable records.

### D08-06 — Реальний PostgreSQL та процесні failure tests у CI

У [package.json](../apps/api/package.json) `npm test` запускає `tests/*.test.ts`, а PostgreSQL suites мають окремий `test:postgres`. У перевіреному [workflow](../.github/workflows/ci-cd.yml) цей script не викликається; standalone support Compose лише проходить `config --quiet`, тоді як контейнерний smoke виконується на starter composition.

- [ ] Додати mandatory PG suites із disposable schema/DB та міграціями у CI; не підміняти їх memory store тестами.
- [ ] Додати process-level harness: запуск двох worker, керована заглушка моделі/upstream, SIGTERM/SIGKILL і перевірка persisted state.
- [ ] Запускати основні recovery scenarios на published image зі standalone support Compose, узгодивши з D01.
- [ ] Тестовий контроль часу/бар'єрів має задавати момент збою детерміновано; уникати довільних довгих sleep.

## 4. Обов'язкова матриця перевірок

| Сценарій | Доказ готовності |
| --- | --- |
| Crash після DB acceptance, до publish | Після restart той самий run доставлений; один customer message |
| Crash після claim, до model result | Новий fence, bounded recovery; stale worker не записує відповідь |
| Втрата lease під час завислого tool | Новий dispatch заблокований; child завершується; stale output відкинутий |
| Kill після зовнішнього effect, до response | Ledger не дає другого effect; `unknown` доступний для reconciliation |
| Два workers / повторний queue event | Один активний owner; не дублюються proposal та completion message |
| SIGTERM із активними support та insights | Зупинка вкладається в configured deadline, state можна відновити |
| Один noisy business, інший малий | Виміряний bounded вплив; fair admission працює за заданим contract |
| Shared session volume зі stale writer | Новий attempt не читає частково змінений/несумісний checkpoint |

## 5. Файли й порядок виконання

Основні зміни: `src/worker.ts`, `src/server.ts`, `modules/support/turn-queue.ts`, `turn-processor.ts`, `postgres-turn-jobs.ts`, `rate-limit.ts`, `runtime/dsh-model.ts`, `profile.ts`, `core/config.ts`; нові lifecycle/session helpers — за потреби. Нові SQL constraints додавати наступною migration. Зміни shared DTO узгодити з D04, health/metrics — з D09, відновлення backup — з D03.

Порядок: lifecycle + PG gates → lease-loss tests → session ownership → shared admission → multi-worker validation. Не починати з Kubernetes, нового broker або автоматичного autoscaler: спершу довести підтримувану Compose topology.

## 6. Definition of done

- [ ] Усі failure scenarios мають відтворюваний test і результати для конкретного image digest.
- [ ] У документації є підтримувані worker/storage topologies, обмеження і команди scale/drain/recover.
- [ ] Відсутні duplicate business effects у контрольованих fault tests; `unknown` не приховується.
- [ ] Є виміряні shutdown duration, recovery duration, queue age і ресурсний профіль; цільові SLO затверджено за цими вимірами, а не вигадано в цьому плані.
- [ ] CI, runbook та startup diagnostics відповідають поведінці реалізації.
- [ ] Результати й постійні інструкції перенесені в `docs/operations/`; цей task закривається з посиланням на commits і перевірки.
