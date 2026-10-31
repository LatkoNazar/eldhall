# D04 — Стабільний HTTP API, SDK і зрозумілий шлях інтеграції

**Пріоритет:** P0 для першого підтримуваного релізу.  
**Почати після:** основного `TODO.md`; для production identity flow узгодити D07.  
**Результат:** сторонній розробник підключає Eldhall до свого backend без читання внутрішнього коду, ручного копіювання DTO та власної інтерпретації станів виконання.

Це план майбутніх змін. Baseline перевірено на commit `858985f38b82e4e26dafb563e4e794ff01cc9196`; наведені нижче нові DTO, команди та шляхи не є вже доступними API.

## 1. Фактична основа і прогалини

| Спостереження в коді | Наслідок для інтегратора |
| --- | --- |
| [app.ts](../apps/api/src/app.ts) уже реєструє Swagger, `/docs` і `/openapi.json`, але тільки в development; заголовок — `Competition Starter` | Потрібно довести наявну специфікацію до релізного контракту |
| [support/routes.ts](../apps/api/src/modules/support/routes.ts) змішує Fastify schemas і Zod усередині handlers; багато responses не описані schema | Автогенерований документ не є повним описом request/response/error поверхні |
| [contracts.ts](../apps/api/src/modules/support/contracts.ts) і [frontend api.ts](../apps/frontend/src/lib/api.ts) містять окремі інтерфейси; frontend має ручні shape guards | Типи та runtime-перевірки можуть розходитися |
| `GET /cases` приймає тільки `status` і повертає масив через `store.listCases()` | Немає задокументованого bounded cursor contract для великої історії |
| `clientMessageId` уже дедуплікується в [postgres-turn-jobs.ts](../apps/api/src/modules/support/postgres-turn-jobs.ts) | Цю гарантію треба зберегти й правильно надати через SDK |
| Execute повертає 502 із `{proposal, case}` для невдалого/невідомого outcome | Загальне правило «повторюй POST після 5xx» може створити неправильну поведінку клієнта |
| [API_CONTRACTS.md](../docs/API_CONTRACTS.md) описує customer session та deployment-wide operator bearer | Потрібно розділити public client і privileged server integration у прикладах |

Не вважати відсутність SDK відсутністю API: headless endpoints уже є. Робота полягає у повноті, сумісності, пакуванні та перевірці інтеграційного шляху.

## 2. Цільовий досвід

Розробник отримує версійовані image, OpenAPI artifact, SDK і короткий приклад host backend. Він створює/зіставляє клієнта, відкриває case, надсилає повідомлення зі стабільним ID, отримує accepted result і читає фактичний стан до завершення. Погодження й виконання дій доступні лише privileged backend/operator client.

Мінімальний tutorial має працювати через `curl`. TypeScript та Python SDK повторюють той самий сценарій, а optional UI використовує той самий публічний контракт.

**Критерій зручності:** незалежний розробник проходить tutorial із released Docker image без змін коду сервера. Час першої інтеграції вимірювати; початкову ціль до 30 хвилин трактувати як перевірювану продуктову ціль, а не наявний результат.

## 3. Задачі

### D04-01 — Завершити machine-readable контракт

- [ ] Інвентаризувати всі routes, authentication schemes, input/output/status codes і розбіжності з ручною документацією.
- [ ] Для кожного підтримуваного support endpoint додати повні request та response schemas, стабільний `operationId`, приклади й опис business semantics.
- [ ] Визначити одне джерело runtime schemas; генерувати типи/специфікацію з нього. Не підтримувати незалежно третю копію DTO в SDK.
- [ ] Обрати OAS-версію, сумісну з серверним generator і обома SDK generators. Зафіксувати її у compatibility matrix; не переходити на newest specification лише через номер версії.
- [ ] Генерувати `openapi.json` у CI без зовнішньої БД, model keys чи запитів до провайдерів: app factory має отримувати контрольовані dependencies.
- [ ] Публікувати специфікацію як release artifact із hash і server version. Інтерактивну production Swagger UI зробити опціональною, не умовою роботи SDK.
- [ ] Змінити назву API на Eldhall та відокремити support surface від starter jobs у tags/docs.
- [ ] Перевіряти response serialization: схема має виключати секретні/internal fields, а не випадково прибирати необхідний публічний стан.

Новий модуль `apps/api/src/contracts/` або `packages/contracts/` — можливе місце, але вибрати одну модель ownership після інвентаризації.

### D04-02 — Уніфікувати помилки та async lifecycle

Цільове доповнення до помилок:

```json
{
  "detail": "Operation needs reconciliation",
  "code": "action_outcome_unknown",
  "requestId": "req_example",
  "retryable": false,
  "resource": { "kind": "action", "id": "action_example" }
}
```

- [ ] Ввести стабільні machine codes окремо від локалізованого message: `validation_failed`, `version_conflict`, `rate_limited`, `run_in_progress`, `action_outcome_unknown` тощо.
- [ ] Зберегти сумісність `detail` і поточного execute payload; breaking зміни винести у нову API major version.
- [ ] Описати `accepted → queued → running → completed|failed|cancelled` і незалежний action lifecycle.
- [ ] Додати scoped читання run status або повністю описати polling через case; response має містити достатньо даних для відновлення після втрати HTTP-відповіді.
- [ ] Зафіксувати: client-side timeout/cancel очікування не означає скасування server execution.
- [ ] Сформувати retry table: GET retry bounded; 429 з `Retry-After`; writes тільки за гарантованим idempotency contract; `unknown` — query/reconcile.
- [ ] Включити request/correlation ID до підтримуваних помилок, не повертати stack trace чи raw provider error.

### D04-03 — Bounded pagination і filters

- [ ] Додати pagination до cases, messages, proposals/audit та інших необмежених collections.
- [ ] Цільовий envelope: `{items, nextCursor, hasMore}`; default/max limit мають бути явними й валідованими.
- [ ] Для основного історичного порядку використати immutable `createdAt + id` з tie-breaker. Окремо задокументувати поведінку mutable priority/status views.
- [ ] Cursor прив'язати до sort/filter/business scope і version; не використовувати його як заміну authorization.
- [ ] Визначити behavior при змінах даних між сторінками: без обіцянки повного snapshot, якщо він не реалізований.
- [ ] Перевірити SQL query plan та індекси разом із D10.
- [ ] Масивний `GET /cases` не замінювати envelope мовчки. Якщо вже існують зовнішні v1 consumers — додати v2 route або явний перехідний контракт і deprecation.

### D04-04 — Idempotency для host integrations

- [ ] SDK генерує `clientMessageId` один раз для логічного повідомлення й повторно використовує його після timeout.
- [ ] Документувати наявне: той самий ID і body повертають початкове прийняття; інший body з тим самим ID конфліктує.
- [ ] Перевірити однакову semantics worker та explicit inline demo; відмінності явно позначати capabilities.
- [ ] Для потрібних create endpoints додати `Idempotency-Key`: scope principal/business + route + key, request fingerprint, збережений результат і оголошений retention.
- [ ] Паралельні однакові запити створюють один ресурс; reuse key зі зміненим body дає 409.
- [ ] Retention узгодити з найбільшим підтримуваним retry/replay вікном. Після його завершення поведінка має бути відома клієнту.
- [ ] Approve/execute спираються на action ledger головного TODO; SDK не приховує цей контракт повторним створенням action.
- [ ] Оновити CORS allow/expose headers лише для реально потрібних idempotency/correlation/version headers.

### D04-05 — TypeScript і Python SDK

- [ ] Створити proposed `packages/sdk-typescript/` і `packages/sdk-python/` або еквівалент із чітким generator ownership.
- [ ] Generated transport/types тримати окремо від невеликого handwritten convenience layer.
- [ ] Підтримати base URL, timeout, cancellation, custom transport, typed errors, cursor iteration і authenticated customer/admin clients.
- [ ] TypeScript SDK працює в Node і browser там, де endpoint дозволений customer session; не залежить від React або внутрішніх server modules.
- [ ] Python SDK має перевірений async приклад для FastAPI; sync API додати тільки якщо він реально підтримується generator і тестами.
- [ ] Convenience `waitForRun` має deadline/backoff і повертає final state; не тримає приховане необмежене polling.
- [ ] SDK не зберігає операторський ключ у browser storage, не вставляє його в bundle або URL.
- [ ] Package versions, API compatibility і підтримувані Node/Python versions публікувати разом із release notes.
- [ ] npm/PyPI names і registry ownership перевірити до публікації; приклади до того використовують placeholders.

### D04-06 — Identity bridge та приклади

- [ ] Написати server-to-server приклад: host перевіряє свого logged-in user, зіставляє external identity з customer, отримує обмежену сесію згідно з D07.
- [ ] Явно показати, що `businessId`/`customerId` з браузера не є доказом identity, а operator token лишається на backend.
- [ ] Надати маленькі приклади для Node і FastAPI: create case, send, poll, receive result, takeover, approve/execute у staff context.
- [ ] У прикладах змоделювати timeout і відновлення по початковому request/message ID.
- [ ] Optional widget будувати після стабільного headless tutorial; він не повинен вимагати доступу до внутрішньої БД Eldhall.

## 4. Карта реалізації

| Місце | Робота |
| --- | --- |
| `apps/api/src/app.ts` | Swagger artifact generation, error/correlation contract, CORS |
| `modules/support/routes.ts` та інших module routes | Повні schemas, pagination, scoped status endpoints |
| `contracts.ts`, `store.ts`, `postgres-store.ts` | Узгоджені DTO, bounded queries, idempotency storage |
| `apps/frontend/src/lib/api.ts` | Перехід з ручної копії DTO на shared/generated контракт |
| Нові SDK packages | Generated clients і обмежені wrappers |
| `docs/API_CONTRACTS.md`, proposed `docs/sdk/`, `examples/` | Працюючі recipes і compatibility policy |
| CI/release workflow | Spec diff, SDK build, tests проти released image |

## 5. Acceptance і докази

- [ ] Згенерована spec описує кожен stable support route, authentication, усі документовані response codes.
- [ ] Contract tests перевіряють реальні serialized responses, а не лише однаковість двох generated файлів.
- [ ] Invalid body, invalid cursor, stale version, 401/403/404/409/422/429/5xx мають перевірені SDK outcomes.
- [ ] TS і Python приклади проходять проти одного Docker digest; не використовують app source imports.
- [ ] Lost response після accepted message не створює друге повідомлення/turn.
- [ ] Execute з `unknown` не повторює effect автоматично.
- [ ] Browser example не містить operator/provider secret; customer не читає чужий run/case.
- [ ] Поточна frontend поведінка зберігається або мігрується разом із compatibility tests.
- [ ] Release містить spec hash, SDK versions, migration notes і результати clean tutorial.

## 6. Межі та завершення

Спершу контракт і polling, потім SDK, далі події D05. GraphQL, SDK для кожної мови, універсальний admin CLI та новий API gateway не є вимогами цього етапу.

Done — перевірений сценарій стороннього застосунку, повний специфікований контракт і зафіксована політика сумісності. Сам факт появи Swagger UI або npm package не закриває задачу.

Джерела: [поточний API contract](../docs/API_CONTRACTS.md), [OpenAPI Specification](https://spec.openapis.org/oas/latest.html). Конкретну версію generator і OAS перевірити під час реалізації та зафіксувати lockfiles.
