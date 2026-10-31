# D09 — Спостережуваність, health checks і діагностика deployment

**Пріоритет:** P0 для підтримуваного self-hosted релізу.  
**Передумови:** основний [TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md), configuration contract [D02](02-installation-and-configuration.md); lifecycle signals із [D08](08-runtime-reliability-and-scaling.md). Реалізацію базових logs/metrics можна вести паралельно з D08.  
**Результат:** адміністратор визначає причину проблеми без читання коду, а maintainers можуть розібрати інцидент за безпечним діагностичним звітом.

## 1. Перевірений baseline

База — `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01. У [app.ts](../apps/api/src/app.ts) уже є Fastify logging, redaction `Authorization`, `/health/live` та `/health/ready`. [health.ts](../apps/api/src/modules/system/health.ts) перевіряє PostgreSQL і Redis. [worker.ts](../apps/api/src/worker.ts) записує heartbeat; [worker-health.ts](../apps/api/src/scripts/worker-health.ts) перевіряє його свіжість. Це існуючі робочі компоненти, які треба зробити більш інформативними й узгодженими.

У [contracts.ts](../apps/api/src/modules/support/contracts.ts) і [postgres-store.ts](../apps/api/src/modules/support/postgres-store.ts) вже є AgentRun, audit та бізнесові metrics: кількість кейсів/пропозицій, fallback, середня latency. Водночас це не повний operational monitoring: середнє значення не показує хвіст затримок або queue wait; worker warnings здебільшого є рядками `console.warn` без run context. Error serializer API навмисно приховує подробиці помилки. Потрібен безпечний reason code, щоб діагностика не вимагала повернення raw provider error.

За самим налаштуванням redaction не можна робити висновок про фактичний витік. Завдання — перевірити всі serializers і додати регресійні тести для customer sessions, query parameters, tool payloads та dependency errors.

## 2. Цільовий досвід адміністратора

1. `docker compose ps` показує роль і стан контейнера.
2. Health пояснює, чи процес живий і чи приймає роботу.
3. `doctor` із D02 перевіряє конфігурацію, схему БД, queue/worker, published catalog і підключення без business mutations.
4. Для конкретного звернення видно request → durable run → attempt → tool/action → результат.
5. Якщо потрібна допомога, адміністратор створює локальний diagnostic bundle, переглядає його і сам вирішує, чи передавати maintainer.

Базовий deployment має працювати зі stdout logs і звичайним metrics endpoint. Collector, Prometheus/Grafana або SaaS-моніторинг підключаються окремо; вони не є обов'язковими для запуску Eldhall.

## 3. Задачі

### D09-01 — Спільний structured logging contract

- [ ] Додати logger factory і context helper для API, worker, runtime gateway та connector adapter.
- [ ] У кожній події використовувати UTC timestamp, level, service/role, release version, event name, duration за потреби і machine-readable reason code.
- [ ] Передавати `requestId`, `runId`, `attempt`, `actionId`/`proposalId`, а також instance identity там, де вони відомі. Для асинхронної роботи створювати worker context із durable job metadata.
- [ ] `businessId` і `caseId` використовувати лише в захищених logs/audit, а не в публічних diagnostics чи metric labels. Відсутній ID має бути відсутнім, а не випадково заповненим іншим scope.
- [ ] Вхідний request/trace ID перевіряти за форматом і довжиною; не дозволяти ним підмінювати auth context або ін'єктувати log lines.
- [ ] Розділити події normal lifecycle, expected denial, transient dependency failure та internal failure. `deny` за політикою не є аварією всього сервісу.
- [ ] Повторювані outage warnings обмежити за частотою, зберігши counters і recovery event.

Приклад **цільового**, ще не реалізованого log event:

```json
{
  "level": "warn",
  "service": "worker",
  "event": "turn.attempt_failed",
  "runId": "<durable-run-id>",
  "attempt": 2,
  "reasonCode": "model_timeout",
  "durationMs": 20000,
  "retryScheduled": true,
  "release": "<release-version>"
}
```

### D09-02 — Redaction і контроль чутливих даних

- [ ] Централізувати redaction для authorization/cookies, `X-Customer-Session`, upstream/MCP credentials, URL userinfo/query secrets і nested error objects.
- [ ] За замовчуванням не логувати raw customer message, документи, prompts, model completions, tool input/output або повний environment.
- [ ] Безпечні заміни: byte counts, hashes версійованих artifacts, тип schema failure, кількість результатів, reason code. Для support debugging доступний audit за правами D07.
- [ ] Зробити тест із synthetic canary secrets у headers, payload, provider error, URL та nested cause. Перевірити stdout, error response, trace export і bundle.
- [ ] Debug mode має bounded retention, явний локальний opt-in та пояснення складу даних. Наявність debug flag не скасовує redaction credentials.
- [ ] Повідомлення клієнту залишається коротким; внутрішній safe diagnostic code дозволяє знайти інцидент без розкриття stack або token.

### D09-03 — Operational metrics окремо від бізнесових

- [ ] Зберегти `/api/v1/metrics` як продуктову статистику; operational endpoint, наприклад `/metrics`, захистити deployment-controlled network/auth policy.
- [ ] Додати counters: accepted/rejected turns, completed/failed/fallback turns, lease loss/recovery, tool outcomes, action unknown, webhook delivery outcomes після D05.
- [ ] Додати histograms: HTTP duration, queue wait, model start і model run, tool duration, DB pool wait, shutdown duration.
- [ ] Додати gauges: queued/active turns, oldest pending age, outbox lag, active runtime children, DB pool використання/очікування, worker availability, disk/free-space стан.
- [ ] Метрики процесу: RSS/heap, CPU, event-loop delay; sessions/cache bytes — якщо збір має прийнятну вартість.
- [ ] Tokens/cost показувати з ознакою походження: actual provider usage або estimate. Невідомий usage не прирівнювати до нуля.
- [ ] Labels обмежити role, route template, bounded outcome/reason, configured provider. Заборонити user/case/run ID, email, URL та довільний tool argument у labels.
- [ ] Для довільних model/tool назв визначити cardinality budget або агрегувати їх; деталі залишити в logs. [Prometheus окремо застерігає](https://prometheus.io/docs/practices/naming/) від labels з необмеженим набором значень.
- [ ] Scrape не має запускати важкі повні scans на кожний запит; counters/gauges отримувати з bounded queries або актуалізованих агрегатів. Зв'язати з D10.

### D09-04 — Health за роллю та admission contract

| Перевірка | Що означає | Чого не робить |
| --- | --- | --- |
| Liveness | Процес відповідає і не перебуває у terminal state | Не викликає LLM або business tools |
| API readiness | Сумісні migrations/config; API може виконувати заявлений admission contract | Не обіцяє, що кожен optional connector доступний |
| Worker readiness | Worker може claim/persist/доставляти роботу і не draining | Не вважає лише наявність PID доказом прогресу |
| Dependency diagnostics | Стан конкретної залежності, причина й останній успіх | Не повертає адреси/секрети без прав |

- [ ] Додати per-check timeout і загальний health deadline. Зависла залежність не повинна нескінченно тримати probe.
- [ ] На startup перевіряти schema compatibility, required config/manifest і доступність потрібних директорій; не логувати їхній приватний вміст.
- [ ] На draining readiness одразу стає негативною, поки liveness лишається позитивною до завершення процесу.
- [ ] Визначити Redis outage policy для API. Якщо PostgreSQL outbox і admission budget дозволяють приймати роботу, позначати брокер як degraded; якщо ні — readiness/admission відмовляє. Цю семантику тестувати, а не визначати лише випадковою комбінацією probes.
- [ ] Worker heartbeat ідентифікує конкретний process/boot, а не лише hostname; не дозволяти старому heartbeat приховати зупинений новий процес.
- [ ] Optional MCP/embedding outage не перетворює liveness на failure. Доступність функції відобразити в operator diagnostics і результаті запиту.

### D09-05 — Трасування без прихованого збору контенту

- [ ] Після стабілізації log context додати опційний OpenTelemetry export через стандартну endpoint-конфігурацію.
- [ ] Основні spans: request acceptance, outbox publish/claim, turn attempt, model initialization/run, knowledge retrieval, connector call, action execution.
- [ ] Між процесами переносити trace linkage у durable metadata; новий retry attempt має окремий span, пов'язаний із тим самим run.
- [ ] Sampling обмежує витрати. Exporter outage не блокує business transaction і не накопичує необмежену пам'ять.
- [ ] Baggage не містить customer content чи credentials; caller-supplied trace metadata не впливає на права.
- [ ] Auto-instrumentation перевірити тестами redaction перед увімкненням. Не покладатися на її defaults як на privacy policy.

### D09-06 — Diagnostic bundle та runbooks

- [ ] Додати до `doctor` з D02 режим безпечного export: версії образів/digests, schema version, enabled capabilities, anonymized counts, dependency checks, bounded safe log events.
- [ ] Bundle створюється локально; автоматичного upload або передачі телеметрії maintainers немає.
- [ ] Виключити `.env`, credentials, DB dump, native session contents і raw customer messages. Перед export показувати manifest того, що потрапить у файл.
- [ ] Додати size/time limits, permission mode для файла та cleanup інструкцію.
- [ ] Runbooks: stuck queue, unavailable model, repeated fallback, manifest mismatch, lease loss, unknown action, DB pool exhaustion, disk full, migration mismatch.
- [ ] Кожен runbook містить симптом → безпечні перевірки → можливі причини → контрольоване recovery → перевірка результату. Заміна `unknown` на `failed` без reconciliation не є recovery.

## 4. Alerting та SLO

Початкові правила повинні ловити actionable симптоми: зростає oldest queued age при відсутньому worker, повторюються lease losses, виникла unknown action, немає успішних завершень за наявності прийнятого навантаження, закінчується місце для persistent state. Окремий low-traffic deployment не повинен отримувати alert лише через нуль завершених jobs.

Числові thresholds встановити після [D10](10-performance-and-storage.md). Визначити denominator і time window для error/fallback rate, розділити infra failure та очікувану бізнесову ескалацію. SLO customer response включає queue wait; model-only latency не видавати за end-to-end latency. Документувати, які SLO залежать від зовнішнього provider.

## 5. Зміни по файлах і порядок

Наявні точки: `src/app.ts`, `src/worker.ts`, `modules/system/health.ts`, `scripts/worker-health.ts`, `modules/support/turn-processor.ts`, `harness.ts`, `contracts.ts`, `postgres-store.ts`, `runtime/dsh-model.ts`, `integrations/mcp.ts`. Запропоновані нові модулі: `src/observability/logger.ts`, `context.ts`, `metrics.ts`, `diagnostics.ts`; paths уточнити при реалізації. Додати `docs/operations/diagnostics.md` і dashboard/alert examples, які використовують фактичні імена метрик.

Порядок: log/reason contract → redaction tests → basic metrics + role health → doctor/runbooks → optional tracing/dashboard. Не чекати на повний telemetry stack для появи корисної діагностики.

## 6. Acceptance і Definition of done

- [ ] За одним run ID можна зіставити API acceptance, worker attempts, tool/action та final outcome через restart процесу.
- [ ] Canary secrets відсутні в усіх перевірених outputs, включно з nested exceptions і diagnostic bundle.
- [ ] Зупинка Redis, PostgreSQL, model endpoint і одного connector дає очікувані різні health/metric/reason результати.
- [ ] Draining і crashed worker не виглядають ready через застарілий heartbeat.
- [ ] Scrape/exporter outage не змінює correctness бізнесових операцій; memory/log volume лишаються bounded.
- [ ] Dashboard показує queue wait, p95 latency, failures і unknown actions; business totals не підміняють operational indicators.
- [ ] Людина, яка не писала код, проходить три підготовлені incident runbooks за документацією; труднощі записані й виправлені.
- [ ] У релізних документах є повний metrics/log schema, privacy defaults, dashboard setup та приклад безпечного bundle.
