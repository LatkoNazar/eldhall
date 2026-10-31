# D05 — Події, надійні webhooks і підключення каналів підтримки

**Пріоритет:** P1; необхідно для інтеграцій, які мають реагувати на результат без постійного polling.  
**Залежності:** головний `TODO.md`, D04; scope/auth узгодити з D07, delivery metrics — з D09.  
**Результат:** host backend отримує зміни case/action, а зовнішній канал передає повідомлення через той самий support pipeline без втрати identity, takeover та idempotency.

Усі нові event DTO, таблиці й endpoints нижче — цільовий дизайн, не вже реалізований функціонал. Baseline: commit `858985f38b82e4e26dafb563e4e794ff01cc9196`.

## 1. На що спиратися

- [API_CONTRACTS.md](../docs/API_CONTRACTS.md) нині пропонує polling case history після HTTP 202. Support routes не мають задокументованого зовнішнього event/webhook API.
- [postgres-turn-jobs.ts](../apps/api/src/modules/support/postgres-turn-jobs.ts) уже атомарно записує customer message і durable turn job; брокер не є єдиним записом прийнятого повідомлення.
- [contracts.ts](../apps/api/src/modules/support/contracts.ts) має audit events, ownership version і action states. Internal audit не слід автоматично оголошувати публічним event contract.
- [routes.ts](../apps/api/src/modules/support/routes.ts) використовує trusted customer session, а staff actions — operator bearer.
- [knowledge/egress.ts](../apps/api/src/modules/knowledge/egress.ts) містить контроль URL/DNS/redirects для імпорту знань. Його принципи корисні для outbound webhooks, але політику webhook targets треба визначити окремо.

Наявні queue/outbox механізми — основа для reuse. Новий брокер або managed webhook provider не є обов'язковими dependencies.

## 2. Контракт публічної події

### D05-01 — Версійований envelope та дозволена проєкція

Цільовий приклад:

```json
{
  "id": "evt_example",
  "type": "action.executed",
  "schemaVersion": 1,
  "occurredAt": "2026-11-01T12:00:00Z",
  "businessId": "business_example",
  "caseId": "case_example",
  "sequence": 18,
  "data": {
    "actionId": "action_example",
    "status": "executed"
  }
}
```

- [ ] Початковий catalog: `message.created`, `run.completed`, `run.failed`, `case.ownership_changed`, `action.awaiting_approval`, `action.executed`, `action.failed`, `action.unknown`.
- [ ] Event виникає після відповідного durable state transition; model text не створює «успішну» action event.
- [ ] Зберігати stable event ID, schema version і monotonic sequence усередині case.
- [ ] Sequence резервувати під тим самим transactional case/aggregate lock, що й зміну стану. Не покладатися на глобальний `BIGSERIAL` як гарантію порядку commit.
- [ ] Розділити customer projection та privileged operator projection. Customer event не містить proposal arguments, policy internals або internal analysis.
- [ ] Мінімізувати payload: IDs/status і дозволені поля; повний актуальний resource читати через scoped API.
- [ ] Права перевіряти також під час читання/replay. Event, який колись був доступний, не надає безстроковий доступ до відкликаних даних.
- [ ] Типи events і їхні schemas включити до versioned contract artifacts D04.

## 3. Durable event/outbox pipeline

### D05-02 — Запис і доставка

- [ ] Додати proposed `support_public_events` та `support_webhook_deliveries` або еквівалент.
- [ ] Product state + public event/outbox row записувати в одній DB transaction. Не використовувати «commit, потім best-effort HTTP callback».
- [ ] Delivery row має endpoint ID/version, event ID, state, attempt count, next attempt, claim lease/fence, останній safe error і response code.
- [ ] Unique constraint `endpointId + eventId` створює одну логічну delivery; attempts записуються окремо.
- [ ] Worker забирає due deliveries bounded batches; довгий зовнішній HTTP request не тримає DB transaction відкритою.
- [ ] Crash/restart відновлює незавершену delivery. Повторне надсилання можливе навіть після remote 2xx, якщо локальний запис receipt не зберігся.
- [ ] Публічна гарантія — **at least once**. Delivery може бути out of order навіть усередині одного case через concurrency/retry; sequence описує committed order і допомагає виявити пропуски. Consumer дедуплікує event ID та впорядковує зміни або перечитує актуальний scoped snapshot.
- [ ] Зберігати event retention і delivery retention окремо; зафіксувати межі replay.

Прийняття webhook споживачем означає durable acceptance, а не завершення всіх downstream дій. Consumer example атомарно зберігає event/inbox record та pending processing state/job і лише тоді відповідає 2xx. Повтор знаходить той самий unfinished inbox item. Один запис dedup key без durable processing може втратити роботу після crash.

### D05-03 — Відмови, retry і replay

- [ ] Задати bounded exponential backoff із jitter, timeout, maximum attempts і максимальний вік delivery. Початкове 24-годинне вікно — запропонований default, що перевіряється на сценаріях.
- [ ] Network failures, 408, 429 і transient 5xx повторювати згідно з policy; враховувати обмежений `Retry-After`.
- [ ] Інші постійні 4xx показувати як failed/configuration issue; 401/403 не крутити безкінечно.
- [ ] Redirect не виконувати автоматично: endpoint change має пройти звичайну validation.
- [ ] Після вичерпання retries зберігати failed delivery з дією «повторити» в admin API.
- [ ] Manual replay використовує початковий event ID і незмінний business payload, але новий attempt ID/time/signature.
- [ ] Повтор callback ніколи сам по собі не повторює refund/cancel або інший business effect у Eldhall.
- [ ] Disable endpoint блокує нові dispatch; in-flight outcome фіксується. Delete/retention не стирає необхідний audit.
- [ ] Перед кожним dispatch/replay повторно перевіряти чинні subscription scopes. Відкликані дані не надсилати зі старої черги; suppressed delivery фіксується з причиною, без підміни незмінного event payload.

## 4. Автентифікація та egress

### D05-04 — Підписані webhooks

- [ ] Реалізувати перевірений signing contract, сумісний зі Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
- [ ] Підписувати exact raw payload bytes і визначені spec metadata; consumer перевіряє підпис до parse/side effects.
- [ ] Дати готові TS/Python verification examples із constant-time comparison та обмеженням допустимого timestamp.
- [ ] Secret — окремий для endpoint; не один загальний на всі businesses/recipients.
- [ ] Rotation підтримує bounded overlap старого/нового key. Зафіксувати key version і аудит активації; після завершення overlap старий key недійсний.
- [ ] Стабільний event ID використовується для dedup; timestamp повторної спроби є новим. Replay protection і business dedup — різні перевірки.
- [ ] Секрети й raw sensitive payload не потрапляють у request logs або diagnostics bundle.

Заголовки, rotation і verification узгодити з [офіційною специфікацією Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md). Решта delivery policy — явний контракт Eldhall.

### D05-05 — Реєстрація endpoint

- [ ] Endpoint створює автентифікований адміністратор у своєму scope; підписка містить explicit event allowlist.
- [ ] URL, DNS answers і фактичний connect target проходять egress validation; credentials у URL заборонені.
- [ ] Зовнішні HTTPS endpoints і deployment-approved internal origins мають різні явні policies. Не дозволяти весь private network через unchecked user input.
- [ ] Перевіряти кожну спробу після DNS changes; не довіряти одноразовій validation при створенні endpoint.
- [ ] Підтримати контрольований test delivery з synthetic payload, який не відкриває справжні дані.
- [ ] Додати bounded quotas: endpoint count, concurrency, response bytes, attempts, queued deliveries.
- [ ] URL update змінює endpoint version і потребує перевірки. Pending deliveries прив'язати до endpoint version, щоб вони не змінили адресата непомітно.

## 5. Polling і optional SSE

### D05-06 — Оновлення для клієнтського чату

- [ ] Polling з D04 лишається підтримуваним способом відновлення стану.
- [ ] Додати case-scoped events endpoint із `afterSequence` або еквівалентом; expired cursor повертає явну відповідь із вимогою перечитати snapshot.
- [ ] SSE, якщо включений у реліз, читає той самий durable event log, має event ID, heartbeat і reconnect contract.
- [ ] Native `EventSource` не використовувати з bearer у query string. Для поточного `X-Customer-Session` підтримати authenticated fetch-stream або інший явно перевірений session transport.
- [ ] Перевірити CORS, proxy buffering, idle timeout, disconnect і bounded кількість активних streams.
- [ ] Snapshot + sequence boundary мають не втрачати події між початковим GET і підключенням stream.
- [ ] Customer authorization перевіряти при підключенні й після її відкликання; stream не зберігає доступ довше за сесію.
- [ ] Потік передає committed product events. Проміжні model tokens, якщо колись додані, є окремим ephemeral contract і не позначають виконання дії.

Формат SSE та reconnect через `Last-Event-ID` описані в [WHATWG HTML](https://html.spec.whatwg.org/multipage/server-sent-events.html). Сам SSE не забезпечує durable storage або exactly-once delivery.

## 6. Канали підтримки

### D05-07 — Один reference channel adapter

- [ ] Після generic webhook API обрати один канал за реальним pilot: host chat, Telegram або helpdesk. Не робити одразу каталог усіх платформ.
- [ ] Вхідний handler перевіряє provider signature/secret за документацією конкретного каналу до прийняття повідомлення.
- [ ] Identity mapping: configured business + channel/account + external user/thread. Ім'я або email із тексту не є identity proof.
- [ ] Durable inbox має unique external message ID у правильному account scope; duplicate delivery повертає receipt без другого turn.
- [ ] Зберігати mapping external thread ↔ case, message ↔ provider message; edits/deletes явно підтримати або документовано відхилити.
- [ ] Перший adapter підтримує text-only; attachment download/scan не вмикається приховано.
- [ ] Staff takeover/resume використовує існуючий ownership version. Канал не запускає паралельного agent loop.
- [ ] Вихідна відповідь передається через окремий delivery outbox після committed message; provider send timeout має власний unknown/reconciliation outcome.
- [ ] Там, де provider не дає idempotency або status lookup, чесно описати ризик повторного outward message та порядок ручного відновлення.
- [ ] Погодження business action через канал не вважати автоматично дозволеним: потрібен перевірений staff principal і точний proposal/hash.

## 7. Карта файлів і етапи

| Proposed область | Робота |
| --- | --- |
| `modules/events/` | Public schemas, append/read, projection, per-case sequence |
| `modules/webhooks/` | Endpoint config, signing, dispatcher, replay/admin routes |
| Наступні SQL migrations | Events, deliveries, inbox dedup, indexes/leases |
| `worker.ts` | Bounded webhook delivery worker; reuse існуючої інфраструктури |
| `modules/channels/<reference>/` | Provider ingress/egress mapping |
| SDK packages та `examples/webhook-consumer/` | Verification, dedup, reconnect і recovery examples |
| `docs/events.md`, `docs/channels/` | Versioning, retry/retention, signing і operational contract |

Етапи: event contract/outbox → signed webhook із replay → reference channel → optional SSE. Подальший канал реалізується через adapter contract, а не копіювання core logic.

## 8. Acceptance і завершення

- [ ] Crash між DB commit і HTTP dispatch не губить подію; crash після remote receipt допускає duplicate із тим самим ID.
- [ ] Parallel workers не створюють неконтрольовані активні attempts.
- [ ] Події різних cases можуть прийти поза порядком; consumer все одно збирає правильний стан.
- [ ] Same-case event 19 приходить раніше 18, повтор 18 надходить двічі: consumer не відкочує актуальний стан і не губить pending processing після crash.
- [ ] Invalid signature, altered body, stale timestamp, rotated-away key і чужий business scope відхиляються.
- [ ] DNS rebinding, redirect і unapproved private target блокуються.
- [ ] Endpoints 429/500/401 проходять визначений retry/terminal сценарій.
- [ ] Replay одного event не створює повторний business effect.
- [ ] Reconnect/expired cursor дають правильне відновлення без витоку internal events.
- [ ] Duplicate inbound channel message не запускає два turns; takeover блокує застарілу bot reply.
- [ ] Оператор бачить delivery backlog, oldest pending age, retries, failed/replay та причини.
- [ ] Приклад стороннього consumer проходить проти released image, включно з вимкненням мережі й рестартом.

Done означає завершений delivery lifecycle і працюючий зовнішній consumer. Додавання HTTP callback без durable outbox, підпису та recovery не закриває задачу.
