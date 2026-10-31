# TODO — OpenAPI → MCP, дозволи операцій і кероване виконання

> Тимчасовий план реалізації. Створено 2026-11-01, часовий пояс Europe/Kyiv.
> База перевірки: commit `f55e8c6c8603d822a915b73c57aba55cbf439de1` у `main`.
> Цей файл описує заплановану роботу, а не вже реалізовані можливості.
> Після виконання критеріїв готовності, завершення всіх PR і перенесення постійної документації видалити цей `TODO.md` окремим фінальним комітом.

## 1. Мета і погоджені рішення

Додати бізнесу можливість підключити власний OpenAPI, отримати з нього контрольований набір MCP tools і налаштувати дозволи для кожної операції або групи операцій. Сапорт-агент має працювати з цими інструментами через наявний harness, серверну політику, погодження оператора та журнал виконання.

Цільовий сценарій:

1. Власник deployment імпортує специфікацію й отримує каталог операцій.
2. Переглядає потрібні операції, визначає scope, перетворення input/output та бізнесові перевірки.
3. Публікує точну версію каталогу й активує вибрані операції.
4. У конфігурації або операторському інтерфейсі задає `auto`, `ask` чи `deny` для інтеграції, груп та окремих операцій.
5. Агент викликає операцію через TS backend. Backend перевіряє актуальну політику і або виконує її, або створює proposal, або відмовляє.
6. Користувач бачить підтверджений результат чи чесний статус очікування/невизначеності. Оператор бачить аргументи, причину рішення і audit.

### Розподіл TypeScript / Python

- **TypeScript залишається основною мовою продукту:** Fastify API, worker, harness, policy resolver, permissions, proposals, execution ledger, audit, операторський API.
- **Python — окремий невеликий сервіс `apps/mcp-openapi/`:** FastMCP, імпорт OpenAPI, нормалізація схем, адаптація запитів/відповідей і звернення до upstream API.
- React/TypeScript UI працює через операторський API; правила виконання завжди перевіряє backend.
- Рішення `auto/ask/deny` має однакову семантику для будь-якого model/runtime adapter. Воно не залежить від промпта або від permission UI конкретного CLI.
- Межа між Node і Python — версійований manifest та MCP Streamable HTTP. TypeScript-типів недостатньо для перевірки зовнішнього JSON: зберегти runtime validation.
- Перетворення специфікації на tools зробити детермінованим. LLM не потрібен для виконання імпорту; підказки щодо назв/описів можна додати окремо пізніше.

## 2. Що вже є і що треба розширити

Перевірено за вказаним вище commit. Перед реалізацією звірити ці місця з актуальним `main`.

| Компонент | Поточний стан | Потрібна зміна |
| --- | --- | --- |
| [integrations/config.ts](apps/api/src/integrations/config.ts) | MCP tools мають тільки `access: "read"`, явні schemas, scope bindings та output fields | Версійований каталог, reviewed activation, окрема permission policy |
| [integrations/mcp.ts](apps/api/src/integrations/mcp.ts) | Allowlist, ін'єкція scope, bounded transport/output; виклик read tool | Зберегти транспортні обмеження; усі виклики пропускати через спільний dispatcher |
| [agent/policy.ts](apps/api/src/modules/agent/policy.ts) | Предметні перевірки refund/escalation | Відокремити загальні дозволи від action-specific guards |
| [agent/harness.ts](apps/api/src/modules/agent/harness.ts) | Proposals, `argsHash`, окремі approve/execute | Узагальнити external actions і snapshot погодження |
| [support/store.ts](apps/api/src/modules/support/store.ts), [postgres-store.ts](apps/api/src/modules/support/postgres-store.ts) | Claim execution та резервування платежу | Загальний execution ledger плюс збереження окремого payment invariant |
| [runtime/dsh-model.ts](apps/api/src/runtime/dsh-model.ts), [support-gateway.mjs](apps/api/runtime/support-gateway.mjs) | `call_business_tool` описаний як read-only; рішення містить фіксовані бізнесові дії | Контракт виконання/pending/denied для зовнішніх операцій |
| [support/factory.ts](apps/api/src/modules/support/factory.ts), [integrations/bootstrap.ts](apps/api/src/integrations/bootstrap.ts) | Config читається на startup API і worker | Узгоджена версія manifest; bootstrap не перезаписує нові operator edits |
| [Resources.tsx](apps/frontend/src/pages/Resources.tsx), [Actions.tsx](apps/frontend/src/pages/Actions.tsx) | Є ресурси та інтерфейс погодження дій | Каталог інтеграцій/permissions і узагальнене відображення actions |

`access: "read"` не можна просто замінити на `"write"`: зовнішня дія має потрапити в policy, proposal та execution pipeline. Так само MCP annotations не є механізмом авторизації.

## 3. Межі першого завершеного релізу

- [ ] Підтримати один задокументований шлях імпорту локального OpenAPI JSON через команду в Python-пакеті.
- [ ] Зберігати результат імпорту у версійованих deployment artifacts: нормалізована специфікація і manifest.
- [ ] Підтримати керування reviewed/active operations і permissions через операторський API та UI.
- [ ] Підтримати `auto`, `ask`, `deny` та успадкування на рівнях integration → group → operation.
- [ ] Реалізувати read tool і write action на окремому тестовому Orders API: `getOrderStatus` та `cancelOrder`.
- [ ] Підтримати обидва режими для перевіреної write action: `ask` і явно налаштований `auto`, з однаковими guards та execution ledger.
- [ ] Перевірити роботу в PostgreSQL + API + worker + Python sidecar через standalone Compose.

Перший імпорт працює як deployment-процедура: підготувати artifacts, змонтувати їх і перезапустити процеси. Зміна permissions для вже опублікованого manifest працює через БД без перезапуску. Self-service upload специфікації через браузер, довільний URL import та hot reload Python-каталогу — наступне розширення; вони не повинні затримувати цю реалізацію.

Повноцінні SSO/RBAC, конструктор workflow, довільні Python/JS scripts у правилах і переписування model runtime не входять у цю задачу. Поточний operator bearer лишається deployment-wide адміністративним доступом; це потрібно чесно відобразити в документації.

## 4. Каталог операцій, ідентичність і версії

### 4.1. Нормалізований manifest

- [ ] У заголовку manifest зберігати `schemaVersion`, `generatorVersion`, `adapterContractVersion` та hash нормалізованої специфікації.
- [ ] Для кожної операції зберігати:
  - `operationKey` — однозначний ключ HTTP method + path template всередині integration;
  - `operationId` — ім'я зі специфікації, якщо задане;
  - `toolName` — детерміноване унікальне MCP-ім'я;
  - `method`, `path`, `title`, опис, точні OpenAPI tags;
  - переглянуту класифікацію `effect: read | write`;
  - обмежену model-facing input schema;
  - mappings path/query/body і trusted scope bindings;
  - approved output projection;
  - ідентифікатор зареєстрованого guard/adapter, коли він потрібен;
  - підтримку provider idempotency та спосіб reconciliation, якщо вони відомі;
  - `operationHash` — fingerprint нормалізованого визначення.
- [ ] Повна ідентичність виклику включає `businessId + integrationId + operationKey`. Однаковий `operationId` у двох інтеграціях не означає одну дію.
- [ ] Відсутній `operationId` обробляти детермінованим ім'ям від method/path; дублікати й колізії в межах інтеграції показувати як помилки імпорту.
- [ ] `manifestHash` має охоплювати нормалізовані операції, schemas, mappings, scope/output transforms та ревізію adapter contract; саме поле hash виключити з вмісту, який хешується.
- [ ] На стадії import невідомий effect позначати як `unknown` у review report. Публікація executable operation потребує явного reviewed `read` або `write`.
- [ ] `connectionRevision` описує reviewed upstream target/auth principal mapping. Значення секретів у manifest або hash не включати. Ротація токена того самого principal не повинна вимагати публікації секрету.
- [ ] `policyRevision` — окрема монотонна версія операторських правил. Зміна режиму не змінює OpenAPI manifest.
- [ ] Зміни method/path, schemas, scope, output projection, tags/membership чи adapter mapping вимагають перегляду нової операції.
- [ ] Форматування JSON і перестановка незначущих ключів не повинні створювати новий fingerprint. Для hash використовувати задокументовану канонізацію.

### 4.2. Reviewed activation окремо від permission

Для операції потрібні `enabled` і `reviewedOperationHash`. Вона доступна лише якщо активна інтеграція, `enabled === true` та reviewed hash збігається з поточним `operationHash`.

- [ ] Імпорт створює каталог кандидатів з `enabled: false` і без reviewed hash.
- [ ] `default: auto` або `Orders: auto` не активує щойно додану операцію.
- [ ] Публікація фіксує точний manifest і переглянутий перелік операцій. Не застосовувати live wildcard до ще не переглянутих endpoints.
- [ ] Змінені операції вимикаються до повторного review; видалені стають недоступними.
- [ ] Усі activation/deactivation/review події мають audit.
- [ ] Review/activation інструмента і approval конкретного виклику — окремі дії.

## 5. Семантика permissions

| Значення | Серверна поведінка |
| --- | --- |
| `auto` | Виконати без окремого погодження після всіх перевірок |
| `ask` | Створити durable proposal, чекати operator approval та окремого execute |
| `deny` | Не рекламувати tool моделі; відхилити також прямий виклик |
| `inherit` | Відсутній локальний override; застосувати наступний рівень правил |

`allowed` окремим режимом не вводити. `inherit` дозволений для операцій/груп, але не для integration default. Початковий default — `deny`.

### 5.1. Детермінований resolver

- [ ] Реалізувати чисту функцію в новому `apps/api/src/integrations/permissions.ts`.
- [ ] Спершу перевірити бізнес, активність інтеграції, узгодженість manifest, enabled/reviewed state та обов'язкові заборони.
- [ ] Explicit endpoint rule, відмінний від `inherit`, має пріоритет над груповими defaults.
- [ ] Якщо endpoint успадковує, зібрати explicit правила всіх його груп. При конфлікті застосувати `deny > ask > auto`.
- [ ] Якщо explicit групових правил немає, застосувати integration default.
- [ ] Відсутня або некоректна policy означає `deny`; помилка завантаження policy не відкриває доступ.
- [ ] Повертати `mode`, `source`, `matchedRuleIds`, `policyRevision` і стабільний `reasonCode`.
- [ ] Порядок tags або JSON-ключів не впливає на результат.

Груповий `deny` у цій моделі є default і допускає явний endpoint override. Абсолютні бізнесові заборони, scope та ownership checks не допускають такого override. UI має пояснювати цю різницю.

Для MVP групи — exact OpenAPI tags або явний список `operationKey`. Regex/wildcard precedence не додавати.

### 5.2. Ілюстративна конфігурація

Це цільова модель, яку ще треба реалізувати у schema/bootstrap; поточний `support.config.json` такі поля не приймає.

```json
{
  "integrationId": "orders",
  "manifestHash": "<normalized-manifest-sha256>",
  "policyRevision": 1,
  "defaultMode": "deny",
  "groups": [
    {
      "id": "orders",
      "selector": { "tag": "Orders" },
      "mode": "ask"
    },
    {
      "id": "billing",
      "selector": { "tag": "Billing" },
      "mode": "ask"
    }
  ],
  "operations": [
    {
      "operationKey": "GET /orders/{order_id}",
      "enabled": true,
      "reviewedOperationHash": "<reviewed-read-operation-sha256>",
      "mode": "auto"
    },
    {
      "operationKey": "POST /orders/{order_id}/cancel",
      "enabled": true,
      "reviewedOperationHash": "<reviewed-cancel-operation-sha256>",
      "mode": "inherit"
    },
    {
      "operationKey": "DELETE /customers/{customer_id}",
      "enabled": false,
      "reviewedOperationHash": null,
      "mode": "deny"
    }
  ]
}
```

У цьому прикладі статус читається автоматично, скасування успадковує `ask` від Orders, видалення клієнта недоступне.

### 5.3. Guards, що діють у кожному режимі

- [ ] Trusted `businessId`/`customerId` отримувати тільки із серверного контексту. Заборонити модельне заповнення reserved scope fields навіть правильним значенням.
- [ ] В adapter mapping явно визначити, куди потрапляє scope у конкретному API: path/query/body або серверний header.
- [ ] Якщо upstream IDs відрізняються від внутрішніх IDs Eldhall, додати явне server-controlled mapping.
- [ ] Перевіряти ownership цільового об'єкта. Переданий `customer_id` сам по собі не доводить належність замовлення.
- [ ] Перевіряти бізнесові передумови: наприклад, скасування лише до відправлення; сума, currency, допустимі значення й обов'язкові обмеження платежів.
- [ ] Для mutation перевірку стану/ownership бажано забезпечити атомарно в upstream або через expected resource version. Preflight-read на боці агента не усуває race між read і write.
- [ ] Власні guards реалізовувати зареєстрованим adapter code, а не виконанням довільного коду з OpenAPI/config.
- [ ] Sentiment, confidence та текст клієнта не змінюють права.
- [ ] HTTP method і MCP annotations використовувати як метадані для review. Наприклад, `POST /orders/search` може бути read; method не є достатньою підставою для `auto`.

## 6. Python OpenAPI → MCP adapter

### 6.1. Пакет і importer

- [ ] Додати `apps/mcp-openapi/pyproject.toml`, lockfile, `Dockerfile`, `src/support_mcp/server.py`, `import_openapi.py` та `adapters.py`.
- [ ] Зафіксувати сумісну версію FastMCP і її залежностей у lockfile; перевірити MCP-сумісність із встановленим TS client.
- [ ] Зробити команду імпорту локального OpenAPI JSON → normalized spec + manifest + review report.
- [ ] Для першої версії явно підтримати перевірений subset OpenAPI 3.0/3.1. Інші версії відхиляти з поясненням.
- [ ] Local `$ref` розгортати з обмеженнями розміру/глибини/циклів. Remote refs, callbacks, webhooks і невідомі schema constructs не підвантажувати автоматично.
- [ ] Unsupported `oneOf`/`allOf`/binary/multipart або інші конструкції не перетворювати мовчки на довільний object. Або коректно нормалізувати і протестувати, або позначати операцію unsupported.
- [ ] Під час нормалізації виконувати поточні bounded input rules у TS: `additionalProperties: false`, обмеження nesting, рядків, arrays та загального payload.
- [ ] Нові tools не повинні автоматично потрапляти у runtime catalog тільки через наявність у spec.
- [ ] Виводити diff операцій при повторному імпорті: unchanged / added / changed / removed / unsupported.

### 6.2. Виклик upstream

- [ ] Використати `FastMCP.from_openapi()` для механічного створення базових tools; потрібні scope/output/business адаптації додати явно.
- [ ] Виставляти лише опублікований catalog; перевірити фактичні tool names/schema проти manifest. FastMCP за замовчуванням може імпортувати всі маршрути — це не є нашим правилом доступності.
- [ ] Upstream base URL та credential references задає deployment owner. Значення `servers` зі сторонньої spec не повинно самостійно змінити довірений target.
- [ ] Business API credentials зберігати в Python environment/secret mount. TS отримує credential для MCP connection. Модель і frontend не отримують жодного з цих секретів.
- [ ] MCP transport між TS і sidecar автентифікувати окремим service credential.
- [ ] Write-tools доступні тільки довіреному TS caller; service credential та прямий виклик sidecar не надавати model runtime. Єдиний бізнесовий invocation path у TS проходить dispatcher/ledger; metadata check не може dispatch write.
- [ ] Зарезервовані scope arguments додавати на trusted boundary. Adapter перевіряє їх і належність object до scope перед поверненням даних/дією.
- [ ] Нормалізувати upstream result до погодженого flat object або bounded array; лишити тільки approved fields.
- [ ] Вкладені відповіді перетворювати explicit mapper; не послаблювати всі output restrictions лише щоб пропустити довільну API-відповідь.
- [ ] Розрізняти підтверджену помилку без effect і невизначений outcome після можливого effect.
- [ ] Не повертати raw upstream errors, headers, secrets або внутрішні поля у model context.
- [ ] Додати фіксований службовий MCP tool `get_connector_manifest`: integration ID, фактичний завантажений manifest hash, adapter contract revision та fingerprints catalog.
- [ ] Цей службовий tool доступний лише backend-перевірці через той самий автентифікований MCP endpoint і не потрапляє в model-facing registry. Так не потрібно обходити поточне обмеження transport на один exact endpoint.
- [ ] Container healthcheck перевіряє готовність сервісу; backend окремо звіряє manifest/tool schemas. Сам збіг hash підтверджує сумісність artifacts, але не замінює review та business guards.

Python adapter не приймає рішення, чи погодив оператор конкретний виклик. Це рішення TS backend. Upstream при цьому продовжує перевіряти власну авторизацію.

## 7. TS dispatcher і model-facing контракт

- [ ] Додати спільний dispatcher, наприклад `apps/api/src/modules/agent/action-dispatcher.ts`, та registry executable actions.
- [ ] Відокремити transport invocation від permission decision, scope validation, proposal lifecycle і audit.
- [ ] Усі зовнішні tools, включно з `auto` reads/writes, викликати через цей boundary.
- [ ] Залишити scoped runtime facade `call_business_tool`; розширити його опис і результат для read/write/pending. Модель передає тільки integration ID, tool name та дозволені arguments.
- [ ] Оновити `AgentContext`, `BusinessIntegrations`, `DshSupportModel` і `support-gateway.mjs` узгоджено.
- [ ] Для нових external actions не додавати окрему гілку фінансового intent у кожному шарі.
- [ ] Built-in refund/escalation оформити як adapters того самого pipeline, зберігши їхні предметні guards і поточну поведінку.
- [ ] Наявний refund guard продовжує вимагати approval; integration/group `auto` його не послаблює.
- [ ] Для v1 дозволити не більше однієї нової external write action на durable turn, зі звичайним bounded набором reads. Ліміт зберігати й забезпечувати в БД для всіх attempts, а не лічильником одного model process.

Цільовий результат dispatcher:

```ts
type BusinessToolResult =
  | { status: "executed"; actionId?: string; data: unknown }
  | { status: "awaiting_approval"; proposalId: string; summary: string }
  | { status: "denied"; reasonCode: string }
  | { status: "failed"; actionId?: string; reasonCode: string }
  | { status: "unknown"; actionId: string; reasonCode: string };
```

- [ ] `ask` повертає `awaiting_approval`, завершує поточний bounded turn і зберігає proposal у БД. HTTP request, model process і worker lease не чекають людину.
- [ ] Read operation з `ask` також не викликається до погодження: отримання даних теж може потребувати дозволу.
- [ ] Модель не вважає pending result успішним і не запускає залежну дію на підставі неотриманого результату.
- [ ] Після recorded execution backend додає статус/результат до кейсу через серверний шаблон. Автоматичне відновлення model loop після approval не є необхідним для v1.
- [ ] Outcome, audit і завершальне повідомлення фіксувати транзакційно або через durable outbox; дедуплікувати completion за action ID. Після recovery клієнт отримує один підсумковий статус і не лишається на «очікуємо погодження».
- [ ] Зміна ownership/policy/manifest блокує нові виклики й delivery застарілого результату. Уже відправлений HTTP effect не вважати скасованим лише через cancellation signal.
- [ ] Якщо write вже dispatched, його фактичний результат і audit зберігаються навіть після takeover/revocation; застаріла модельна відповідь блокується окремо. Не губити execution outcome через завершення turn lease.

## 8. Proposal, approval та надійне виконання

### 8.1. Незмінний snapshot

- [ ] Розширити proposal: business/customer/case, integration ID, operation key/hash, manifest hash, connection revision, policy revision, effect, normalized arguments, decision source, expiry, guard results.
- [ ] Hash обчислювати після schema normalization, defaults і trusted scope injection. Включити контекст та версії; секрети не включати.
- [ ] Зберігати snapshot незмінним. Зміна суттєвого аргументу, operation mapping, target або policy потребує нового proposal.
- [ ] Погодження створює лише автентифікований operator. Повідомлення клієнта «так» або model output не є operator approval.
- [ ] `approve` лише фіксує згоду на конкретний hash. `execute` залишається окремою операцією.
- [ ] Перед execute повторно перевірити approval TTL, snapshot/hash, чинні права, reviewed state, scope, ownership і поточні business guards.
- [ ] На старті зберегти чинний approval TTL 15 хвилин. Прострочені або invalidated proposals отримують явний terminal outcome/reason і не лишаються удавано виконуваними.
- [ ] Policy-only update для integration v1 інвалідує її pending/approved snapshots консервативно. Точніше відстеження залежностей правил можна додати пізніше.
- [ ] При `ask → auto` старий pending proposal не виконується сам собою; наступний новий виклик оцінюється за новою policy.
- [ ] Takeover case, disable integration та зміна active manifest інвалідують невиконані proposals.

### 8.2. Execution ledger та idempotency

- [ ] Перед будь-якою write action створювати durable action/execution record у PostgreSQL.
- [ ] Окремо зберігати origin authorization: `operator_approval` або `policy_auto`. Автоматична дія не повинна виглядати як погоджена людиною.
- [ ] Atomic claim перевіряє стан action/proposal та актуальні ревізії перед переходом у `executing`.
- [ ] Узгодити check+claim транзакційно з policy edit, takeover та draining. Draining блокує нові claims/dispatch, включно з прямим execute уже погодженого proposal. Раніше admitted execution обліковується як in-flight; відкликання не гарантує відсутність уже початого remote effect.
- [ ] Два конкурентні execute одного action не можуть отримати два активні dispatch.
- [ ] Не тримати DB transaction/row lock відкритими протягом зовнішнього HTTP request.
- [ ] Stable idempotency key прив'язати до durable `actionId`/execution identity. Повтор delivery тієї самої action використовує той самий ключ.
- [ ] `argsHash` не є універсальним унікальним ключем action: нова легітимна дія з такими самими аргументами може бути окремою action.
- [ ] Logical proposal/action ID зберігати між retries turn job. Recovered model turn або повторний tool call знаходить наявну дію за durable turn/action slot, а не генерує новий випадковий ID; database uniqueness не допускає другого effect.
- [ ] Business-specific deduplication лишити в adapter: для refund резервування payment; для cancellation — перевірка стану/order version.
- [ ] Якщо upstream підтримує idempotency, передавати стабільний ключ у погодженому header/body mapping.
- [ ] Після timeout/crash, коли effect міг відбутися, фіксувати `unknown`. Не виконувати автоматичний повтор без доведеного безпечного механізму provider.
- [ ] Для `unknown` передбачити reconciliation через status endpoint/provider reference або ручну перевірку оператором.
- [ ] Відновлення після рестарту не має переводити незавершений dispatched write назад у необмежений retry.
- [ ] Обидва режими, `auto` і `ask`, використовують той самий ledger/executor.
- [ ] Успішний user-facing статус з'являється лише після збереження підтвердженого результату.

Локальний claim та HTTP timeout не гарантують exactly-once execution зовнішнього API. Документація має описувати фактичні гарантії й межі конкретного adapter.

### 8.3. Audit

- [ ] Записувати import/review/publish/activate/disable, policy edit, proposal, approval/rejection, claim, dispatch outcome та reconciliation.
- [ ] Зберігати actor, business/integration/operation, action/proposal IDs, hash/revisions, rule source, timestamps та reasonCode.
- [ ] Редагувати чутливі значення в логах; повний payload показувати лише в дозволеному операторському контексті.
- [ ] Для failed/unknown відображати реальний стан, без фіктивного «скасовано» чи «виконано».

## 9. Persistence, bootstrap та операторський API

### 9.1. Джерело істини

- [ ] Deployment config задає connector location, credential environment names і початковий manifest/policy.
- [ ] PostgreSQL є authoritative для активної версії інтеграції, reviewed/enabled operations, policy revision, proposals та executions.
- [ ] Додати immutable manifest revisions і mutable integration state з optimistic version.
- [ ] API та worker читають актуальний policy state з того самого store. Не дозволяти незалежним startup copies керувати виконанням.
- [ ] Для v1 перевіряти активний revision перед dispatch із БД; cache допускається лише з перевіркою актуальності.
- [ ] Bootstrap з тим самим revision/content — idempotent; конфлікт однакових revision із різним вмістом — помилка.
- [ ] Старіший файл не перезаписує operator edits і не вмикає integration, яку оператор вимкнув. Зберігати revision/tombstone watermark.
- [ ] Зміни policy робити через compare-and-swap; stale edit повертає 409.
- [ ] Legacy explicitly configured read tools мігрувати без розширення їхніх прав: поточні reviewed schemas/scope/allowlist, явний read-auto compatibility profile.
- [ ] Зберегти memory implementation для локального demo; основні гарантії concurrency підтвердити на PostgreSQL.

### 9.2. Зміни сховища

Створити наступну вільну SQL migration, не переписувати вже застосовані migrations.

- [ ] Integration state: business/integration identity, enabled/draining state, active manifest hash, connection revision, policy JSON, policy revision, optimistic version, timestamps.
- [ ] Manifest revisions: immutable normalized catalog і hashes, reviewed activation state або посилання на нього, хто/коли переглянув.
- [ ] Proposal extension: scoped operation snapshot, effect, policy source, revisions та validity metadata.
- [ ] Execution records: action ID, proposal ID за потреби, stable idempotency key, status, attempts, dispatch timestamps, provider ref, bounded result/error.
- [ ] Uniqueness/foreign keys за business/integration/action identity. Не робити універсальний UNIQUE на args hash.
- [ ] Оновити store interfaces, Postgres implementation, memory implementation, startup schema checks та migration runner.

### 9.3. Цільові admin endpoints

Точні DTO зафіксувати в `docs/API_CONTRACTS.md` разом із реалізацією. Всі endpoints нижче — нові, під operator authentication.

| Method | Proposed path | Призначення |
| --- | --- | --- |
| GET | `/api/v1/integrations?businessId=...` | Список інтеграцій, стан і ревізії |
| GET | `/api/v1/integrations/:id/operations?businessId=...` | Catalog, configured/effective mode, source, reviewed state |
| GET | `/api/v1/integrations/:id/policy?businessId=...` | Поточна policy та optimistic version |
| PATCH | `/api/v1/integrations/:id/policy?businessId=...` | Атомарне редагування integration/group/operation rules із expected version |
| POST | `/api/v1/integrations/:id/review?businessId=...` | Погодити точні operation hashes і enable/disable перелік |
| POST | `/api/v1/integrations/:id/activate?businessId=...` | Активувати підготовлений manifest після readiness/hash check |
| POST | `/api/v1/integrations/:id/disable?businessId=...` | Зупинити нові виклики й інвалідувати невиконані proposals |
| POST | `/api/v1/proposals/:id/approve` | Наявний endpoint, розширений для external operations |
| POST | `/api/v1/proposals/:id/execute` | Наявний endpoint, спільний executable action path |

- [ ] Перевіряти integration/business identity у кожному handler. `businessId` query не є доказом authorization.
- [ ] Поточний bearer представляє адміністратора всього deployment. Окремі operator accounts/business ACL треба реалізувати до заяв про ізольовану multi-tenant адміністрацію.
- [ ] Дати 401 для неавтентифікованих, 404 для відсутнього/недоступного ресурсу, 409 для stale revision, 422 для некоректного payload.
- [ ] Response не містить credential values, raw private OpenAPI або непереглянуті upstream internals.
- [ ] Всі model-facing execution entry points окремо перевіряють policy; admin UI не є єдиною точкою контролю.

## 10. Операторський UI

- [ ] Додати сторінку/секцію «Інтеграції» з вибором бізнесу, integration status і manifest/policy revisions.
- [ ] Показувати catalog із групами, operation title, method/path, effect, reviewed state та effective mode.
- [ ] На групі дати bulk rule `Auto / Ask / Deny`; на endpoint — додатково `Inherit`.
- [ ] Показувати джерело: «Ask — успадковано від Orders», «Auto — власне правило», «Вимкнено — нова версія потребує review».
- [ ] Зміна group mode не стирає endpoint overrides; «скинути до успадкування» має бути явною дією.
- [ ] Відокремити enabled/reviewed від permission dropdown. Вибір `auto` не має приховано погоджувати непереглянуту schema.
- [ ] Для конфлікту груп показувати ефективне рішення та matched groups.
- [ ] При stale version запропонувати перечитати поточну policy; не перезаписувати чужі edits.
- [ ] Адаптувати Actions/ActionCard для зовнішніх операцій: зрозуміла назва, ціль, суттєві параметри, reason, actor і статус.
- [ ] Зберегти окремі «Погодити» й «Виконати». Стан `approved` не позначати як успішне виконання.
- [ ] Для pending показувати строк погодження; для unknown — потребу reconciliation.
- [ ] Перевірити клавіатурне керування dropdown/buttons, читабельні labels і disabled/stale states.
- [ ] Операторський API має залишатись повноцінним headless способом керування.

## 11. Docker та керування версіями

- [ ] Додати optional `deploy/support.mcp.compose.yaml` з сервісом `mcp-openapi` у мережі `support`.
- [ ] Запускати MCP Streamable HTTP на внутрішньому `0.0.0.0:8000/mcp`. Публікація порту на host за замовчуванням не потрібна.
- [ ] Монтувати reviewed spec/manifest read-only; секрети передавати окремо. Python image — non-root, з healthcheck, pinned dependencies і відтворюваною збіркою.
- [ ] Node API і worker отримують однаковий manifest/config, MCP service credential та точний service URL.
- [ ] Поточний URL validator не допускає `http://mcp-openapi:8000/mcp`: це не loopback. Додати explicit deployment-owned allowlist для конкретного internal HTTP origin.
- [ ] Зберегти HTTPS за замовчуванням для зовнішніх адрес, відмову від redirects і довільних targets. Не дозволяти весь private network одним загальним bypass.
- [ ] Зберегти bounded timeout/cancellation/output. Не збільшувати ліміти без конкретного API-сценарію та перевірки.
- [ ] Перевірити збірку/запуск sidecar на цільовій ARM64 машині; при підтримці AMD64 описати обидві платформи.
- [ ] Інтеграція без MCP config лишається опціональною. Помилка конкретного connector має бути видимою як unavailable/disabled.

### Безпечна активація static catalog

1. Перевести integration у disabled/draining; зупинити приймання нових викликів.
2. Визначити стан уже dispatched actions; pending/approved старої версії інвалідувати.
3. Підготувати immutable artifacts і новий container/config revision.
4. Перезапустити sidecar, API та worker для catalog change.
5. Перевірити readiness, manifest hash і фактичні tool schemas у всіх учасників.
6. В одній DB transaction із expected version активувати `activeManifestHash` та відповідну policy/reviewed snapshot.
7. Якщо перевірка не пройшла, лишити integration disabled. Docker restart не є частиною DB transaction.
8. Policy-only edits для незмінного manifest застосовувати через DB revision без container restart.

При rollback не повертати автоматично старі дозволи або відкликані approvals; потрібна явна активація сумісного manifest із поточними обмеженнями.

## 12. Послідовність реалізації

### Етап A — зафіксувати контракти

- [ ] Перечитати актуальні `CLAUDE.md`, `docs/ARCHITECTURE.md` і `docs/API_CONTRACTS.md`.
- [ ] Узгодити застарілі хакатонні ownership/branch інструкції з поточною роботою до змін shared contracts.
- [ ] Описати manifest, identity/hashes, permission resolver, proposal snapshot та execution outcome.
- [ ] Додати fixtures маленького Orders OpenAPI і mock upstream із customer ownership.

### Етап B — перший наскрізний read

- [ ] Python import command → reviewed manifest → MCP sidecar.
- [ ] TS registry → trusted scope → `getOrderStatus` у `auto` → projected result.
- [ ] Перевірити чужий order, підміну scope, непереглянутий tool і розбіжність catalog hash.

### Етап C — write через погодження

- [ ] Permissions resolver і generic dispatcher.
- [ ] `cancelOrder` у `ask` → durable proposal → approve → execute → recorded result.
- [ ] PostgreSQL claim, stable idempotency, double-execute і unknown-outcome.
- [ ] Той самий cancel adapter у `auto` із тими самими guards.
- [ ] Regression перевірка наявних refund/escalation flows.

### Етап D — керування і deployment

- [ ] DB policy/reviewed state, migrations, bootstrap compatibility і version conflicts.
- [ ] Admin API та UI для integration/group/endpoint rules.
- [ ] Static catalog publish/activation procedure і Compose overlay.
- [ ] Audit, документація, CI та clean-install smoke.

Почати з етапів A–C: це перевірить архітектуру на реальній другій бізнесовій дії до розширення інтерфейсу.

### Карта основних файлів

| Файли | Робота |
| --- | --- |
| `apps/api/src/integrations/config.ts`, `schema.ts`, `bootstrap.ts` | Нові DTO/config, schemas, ревізії та сумісний bootstrap |
| Нові `integrations/manifest.ts`, `permissions.ts` | Catalog validation і deterministic permission resolver |
| `integrations/mcp.ts` | Збереження transport/scope/output checks; version-aware invocation |
| Новий `modules/agent/action-dispatcher.ts`, `tools.ts`, `policy.ts` | Registry, guards і загальний dispatch |
| `modules/agent/harness.ts`, `model.ts` | Proposals, action results, pending turn behavior |
| `runtime/dsh-model.ts`, `runtime/support-gateway.mjs` | Оновлена facade і перевірка інвентарю |
| `modules/support/contracts.ts`, `store.ts`, `postgres-store.ts` | Snapshot/ledger/revisions і атомарні claims |
| Новий integration admin module, `src/app.ts` | Routes, validation та operator auth |
| `apps/api/migrations/`, `src/migrate.ts` | Наступна migration і schema checks |
| `apps/frontend/src/lib/api.ts`, `pages/Resources.tsx`, `pages/Actions.tsx`, `App.tsx` | UI/DTO/navigation і зовнішні actions |
| Новий `apps/mcp-openapi/` | Importer, FastMCP sidecar, adapters, tests, Docker |
| `deploy/support.mcp.compose.yaml`, `examples/`, `docs/`, CI | Запуск, приклади та перевірений onboarding |

Нові шляхи в таблиці — запропоновані місця, а не вже наявні модулі. Уточнювати їх за фактичним розподілом відповідальностей, зберігаючи описані контракти.

## 13. Перевірки та критерії приймання

### Permission/catalog tests

- [ ] Новий endpoint лишається недоступним навіть за integration/group `auto`.
- [ ] Explicit endpoint override і `inherit` працюють за описаним пріоритетом.
- [ ] Multiple groups дають однаковий результат незалежно від порядку.
- [ ] Глобальний guard не обходиться endpoint override.
- [ ] `deny`/disabled/unreviewed operation блокується також прямим facade/API викликом.
- [ ] Зміна operation schema/mapping/tag membership потребує review.
- [ ] Однакові operation IDs різних integrations не змішують policies.
- [ ] Legacy configured read tools зберігають попередні обмеження.

### Scope, adapter та approval tests

- [ ] Чуже замовлення не читається і не змінюється.
- [ ] Model-provided scope fields відхиляються до outbound request.
- [ ] Nested/private upstream поля відсутні у model result.
- [ ] Redirect, timeout, cancellation, unsupported schema та manifest mismatch обробляються явно.
- [ ] `ask` не виконує upstream operation до approve і execute.
- [ ] Approve сам по собі не спричиняє business effect.
- [ ] Зміна arguments/policy/manifest/connection revision робить approval застарілим.
- [ ] Restart зберігає proposals; expired approval не виконується.
- [ ] Takeover/disable блокує стару pending action.
- [ ] `auto` також перевіряє ownership, guard, limits і актуальні revisions.

### PostgreSQL / concurrency / recovery

- [ ] Два одночасні execute одного action дають один claim/dispatch.
- [ ] Повтор delivery turn job або model/tool call не дублює write effect чи completion message і не обходить one-write-per-turn constraint.
- [ ] Дві незалежні легітимні actions з однаковими args не помилково блокуються лише через args hash.
- [ ] Domain-specific reservation refund не зникає після generic refactor.
- [ ] Crash до/після dispatch і timeout після possible upstream commit дають коректний failed/unknown стан.
- [ ] Unknown не провокує blind retry; reconciliation зберігає audit.
- [ ] Stale policy PATCH повертає 409; restart зі старим config не відновлює відкликаний доступ.

### UI та end-to-end

- [ ] Group edit, endpoint override, inherited source і review/disabled state відображаються коректно.
- [ ] Pending/approved/executed/unknown не змішуються у UI та відповіді агента.
- [ ] Clean deployment проходить: import → review/activate → auto read → ask write → approve → execute → audit.
- [ ] Окремо проходить auto write із business guard і deny без upstream effect.
- [ ] Міграції та реальні PostgreSQL integration tests входять у CI.
- [ ] Саме standalone support Compose із MCP overlay проходить smoke; одного `docker compose config` недостатньо.
- [ ] Release/build packaging включає новий Python image, Compose overlay і потрібні versioned artifacts; production deploy не залежить від файлів, що випадково лишилися на локальній машині.
- [ ] CI smoke використовує mock business API і model fixture, без реальних платежів/клієнтських даних/платних LLM calls.

Наявні команди для перевірки API:

```bash
cd apps/api
npm ci
npm run lint
npm run typecheck
npm test
npm run test:postgres
npm run build
```

Наявні команди frontend:

```bash
cd apps/frontend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`test:postgres` вимагає підготовленої тестової БД і migrations; додати нові integration suites до script/CI, якщо вони не підхоплюються поточним glob. Команди Python lint/tests/import і Compose smoke задокументувати після створення пакета.

Цей TODO-коміт є документацією; перелічені перевірки — acceptance gates для майбутньої реалізації.

## 14. Документація, всі PR та видалення TODO

### Постійна документація

- [ ] Оновити `docs/ARCHITECTURE.md`: TS/Python boundary, generic actions, permissions і execution.
- [ ] Оновити `docs/API_CONTRACTS.md`: integration endpoints, revisions, approval та нові results/statuses.
- [ ] Оновити `docs/integrations-runtime.md`: import/review/activate, config/DB ownership, restart і permissions.
- [ ] Додати перевірений Orders example та інструкцію підключення власного API.
- [ ] Описати supported OpenAPI subset, scope mapping, output projection, idempotency/reconciliation limits.
- [ ] Оновити README quickstart та опис підтримуваних MCP-операцій відповідно до реалізації.
- [ ] Перенести всі постійні рішення з цього файла в відповідні docs.

### Закрити всі PR

На момент створення плану список відкритих PR у `LatkoNazar/eldhall` порожній. Перед завершенням перевірити його повторно, включно з draft PR.

- [ ] Переглянути **всі відкриті PR репозиторію** на момент завершення робіт.
- [ ] Актуальні зміни довести до готовності: review, вирішені конфлікти/зауваження, необхідні checks, потім merge у `main`.
- [ ] Застарілі, дубльовані або непотрібні PR закрити з короткою причиною; не merge їх лише заради порожнього списку.
- [ ] Перевірити, що потрібний код із закритих без merge PR не втрачений і перенесений до прийнятого рішення, якщо він потрібен.
- [ ] Після останнього merge повторно перевірити актуальний `main` і переконатися, що відкритих PR немає.

Цей розділ є завданням для етапу завершення. Створення TODO саме по собі не означає виконання чи закриття PR.

### Умова видалення цього файла

Видалити `TODO.md` **лише коли одночасно виконано все нижче**:

- [ ] Усі обов'язкові роботи цього плану реалізовані й потрапили в `main`.
- [ ] Acceptance сценарії та потрібні CI gates пройшли на фінальному коді.
- [ ] Новий користувач може пройти задокументований clean-install сценарій із прикладом інтеграції.
- [ ] Усі відкриті PR завершені через merge або обґрунтоване close.
- [ ] Постійні інструкції/контракти перенесені у `docs/` та README.
- [ ] Немає незакритого blocker, який приховується простим видаленням checklist.
- [ ] Окремим фінальним комітом видалити кореневий `TODO.md`, наприклад `docs: remove completed OpenAPI permissions TODO`.

Якщо обсяг свідомо змінено, явно погодити новий scope і відобразити незавершені обов'язкові пункти у відповідних issues. Саме перенесення пунктів у backlog не означає, що початковий план виконано.

## Джерела для реалізації

- [Поточна архітектура](docs/ARCHITECTURE.md)
- [Поточні API contracts](docs/API_CONTRACTS.md)
- [MCP runtime/configuration](docs/integrations-runtime.md)
- [FastMCP: OpenAPI](https://gofastmcp.com/integrations/openapi)
- [FastMCP: HTTP deployment](https://gofastmcp.com/deployment/http)
- [Офіційний TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP schema / ToolAnnotations](https://modelcontextprotocol.io/specification/latest/schema)

Версії бібліотек та точні API перевірити під час реалізації, зафіксувати lockfiles і протестувати міжмовний протокольний контракт.
