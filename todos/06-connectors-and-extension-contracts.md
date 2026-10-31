# D06 — Контракти конекторів, приклади та перевірка сумісності

**Пріоритет:** P1; базовий reference connector потрібен до реклами «підключіть свій бізнес».  
**Залежності:** головний `TODO.md`; D04 для публічних DTO, D01 для release artifacts, D07 для credential/identity lifecycle.  
**Результат:** новий конектор додається передбачувано через документований контракт, проходить одну перевірку сумісності й не потребує змін у harness для кожного бізнесу.

Baseline: commit `858985f38b82e4e26dafb563e4e794ff01cc9196`. Головний TODO створює OpenAPI importer, manifest, permissions і generic action executor. Цей документ описує наступний рівень: authoring experience, приклади, compatibility та кероване підключення.

## 1. Що вже зроблено

| Наявна можливість | Подальша робота |
| --- | --- |
| [integrations/config.ts](../apps/api/src/integrations/config.ts) валідовує configured tools, input schema, scope/output bindings, URL та credential reference | Оформити ці вимоги в публічний connector contract після змін головного TODO |
| [integrations/mcp.ts](../apps/api/src/integrations/mcp.ts) має allowlist, trusted scope, bounded transport і результат | Зберегти гарантії при різних adapters, не обходити їх через plugin API |
| [integrations-mcp.test.ts](../apps/api/tests/integrations-mcp.test.ts) уже піднімає реальний HTTP MCP server і перевіряє scope, timeout, redirects, private output | Винести reusable conformance scenarios для авторів конекторів |
| [EXTERNAL_DATA.md](../docs/EXTERNAL_DATA.md) відокремлює support PostgreSQL, зовнішній Qdrant і business data через MCP | Не змішувати business connector із довільною заміною support storage |
| [support.config.json](../examples/support.config.json) містить приклад `get_order_status` | Потрібен runnable upstream приклад, документація та перевірений шлях від чужого API до результату |
| [integrations.md](../docs/integrations.md) позначений як цільовий дизайн | Відокремити реалізовану authoring guide від історичної пропозиції |

Поточні межі, зокрема максимум 20 configured tools на integration і підтримуваний JSON Schema subset, є явною частиною implementation. Збільшувати їх слід за вимірюванням D10, а не заради заяви «будь-який API без обмежень».

## 2. Принцип контракту

Connector — це versioned adapter до конкретної системи з явними операціями, scope, side effects та recovery. Він не отримує право завантажувати довільний код у TS-процес і не встановлює permissions від імені бізнесу.

Підтримати два авторські шляхи:

1. **OpenAPI-backed:** importer і Python/FastMCP sidecar головного TODO, плюс reviewed mappings та невеликі adapters.
2. **Native MCP:** самостійний MCP server, який реалізує той самий manifest/identity/output contract і проходить ті самі conformance tests.

Опціональні DB adapters реалізують названі параметризовані операції через свої credentials. Model-generated SQL або універсальний HTTP proxy не є shortcut для інтеграції.

## 3. Задачі

### D06-01 — Стабілізувати connector manifest

- [ ] Зафіксувати schema, compatibility policy та canonical hashing для manifest, створеного головним TODO.
- [ ] Додати author metadata: connector ID, версію, підтримувані API releases, maintainer/contact, changelog, license reference.
- [ ] Для кожної operation документувати meaning, required arguments, scope mapping, output projection, effect, timeout, expected errors та recovery.
- [ ] Відокремити connector version, upstream API version, manifest hash і policy revision. Зміна документації не повинна непомітно підміняти виконувану schema.
- [ ] Зберігати credential references, а не values. Пояснити minimum upstream scopes і чи підтримується per-business/per-customer principal.
- [ ] Явно описати pagination, rate limits, freshness та максимальну cardinality даних.
- [ ] Для write operation вказати provider idempotency support, status lookup і обмеження повторів. Значення `unknown` має реальний recovery recipe.
- [ ] Сумісність перевіряється за конкретною версією, а не рядком «MCP-compatible».

Це доповнення до manifest головного TODO; не створювати другий незалежний формат permissions.

### D06-02 — Starter kit для автора

- [ ] Додати proposed `examples/connectors/orders/`: маленький business API, data fixtures двох businesses/customers, spec, adapter, reviewed manifest і Compose overlay.
- [ ] Додати мінімальний native MCP variant на основі наявного HTTP test server для перевірки language-independent контракту; не дублювати весь продукт.
- [ ] Автор повинен змінювати лише upstream URL/credential refs, mappings і adapter-specific guards; harness code не редагується.
- [ ] Включити команди `validate`, `inspect` та `test-connection` або їхні аналоги. CLI names у документації позначити як наявні лише після реалізації.
- [ ] `inspect` показує discovered vs published tools, schema/hash mismatch, scope/output limits та unavailable dependencies без секретів.
- [ ] `test-connection` виконує тільки metadata/readiness path. Перевірку write робити окремо в synthetic sandbox з явною назвою сценарію.
- [ ] Offline validation перевіряє manifest/schema/mappings без живого effect; це не називати доказом безпечності upstream.
- [ ] Надати README template із setup, credential scopes, identity mapping, version matrix, limitations і troubleshooting.

### D06-03 — Reusable conformance suite

- [ ] Винести shared fixtures/harness із поточних MCP tests, не замінюючи реальний HTTP handshake моками.
- [ ] Приймати endpoint, expected manifest hash, synthetic scope та test credentials через окрему test configuration.
- [ ] Перевіряти initialize/list/call, advertised schema, protocol compatibility та endpoint allowlist.
- [ ] Negative tests: unknown tool, unreviewed operation, duplicate names, invalid argument, reserved scope override, cross-business/customer object.
- [ ] Перевіряти flat/approved output, bounded bytes/records, sanitization raw errors і відсутність secret values.
- [ ] Fault cases: timeout до dispatch, connection reset після можливого effect, rate limit, malformed response, schema drift, revoked access.
- [ ] Для write сценаріїв рахувати фактичні side effects у synthetic upstream; повтор action ID не створює другого effect.
- [ ] Не тестувати destructive operation production-системи за замовчуванням.
- [ ] Результат suite містить connector version, server digest, contract version, tested capabilities і failed scenarios.
- [ ] Позначка «verified» завжди має конкретну tested combination та дату; успішний handshake не означає перевірену business authorization.

### D06-04 — Коректне identity та data mapping

- [ ] Документувати server-owned mapping між customer Eldhall і external account; зміна customer email не переносить права автоматично.
- [ ] Для API без tenant/customer параметрів adapter має перевірити object ownership через дозволений upstream mechanism або scoped credential.
- [ ] Підміна `order_id` на чужий object не обходить scope тільки тому, що injected customer ID залишився правильним.
- [ ] Cache key включає business/customer/permission context, connector version і parameters; shared cache не повертає чужі дані.
- [ ] Відсутнє identity mapping дає контрольовану відмову/уточнення, а не пошук «схожого» користувача моделлю.
- [ ] Зміна mapping або credential principal інвалідує відповідні pending actions через механізми головного TODO.
- [ ] Tool-returned URLs, instructions і free-form text лишаються даними. Вони не реєструють новий target або permission.

### D06-05 — Зручні бізнесові операції

- [ ] Крім механічного endpoint import надати приклад curated `get_order_context`: потрібні поля замовлення, доставки й дозволених наступних кроків у компактному результаті.
- [ ] Read composition має bounded calls, спільний deadline і явну freshness/partial-result semantics.
- [ ] Не маскувати partial failure порожнім масивом чи вигаданим «нічого не знайдено».
- [ ] Для mutation віддавати перевагу одній upstream business operation із власними guards. Multi-step write workflow вимагає окремого плану partial effects/compensation; він не з'являється автоматично з OpenAPI.
- [ ] Зберігати різницю «можна спробувати дію» і «дія вже виконана». Response повинен містити підтверджені provider state/reference.
- [ ] Показати другий сценарій поза фінансовим demo: наприклад, зміна адреси доставки до відправлення або керування підпискою.
- [ ] Для кожного example дати 5–10 реалістичних support звернень, expected tool/action та escalation cases для D11.

### D06-06 — Вибір tools без перевантаження контексту

- [ ] Фільтрувати permissions/reviewed state до будь-якого relevance ranking.
- [ ] Формувати bounded catalog за business/context і задокументованими tags; невибраний tool не означає назавжди заборонений, а заборонений не може потрапити через пошук.
- [ ] Якщо потрібен tool search, він повертає тільки дозволені descriptors з registry, без arbitrary remote discovery.
- [ ] `ask` tools можуть бути видимими, але їхній опис однозначно повідомляє про approval.
- [ ] Перевіряти selected operation ще раз перед execution; модельна релевантність не є authorization.
- [ ] Виміряти tool-selection accuracy, latency й context cost для малого та великого catalog.
- [ ] Не підвищувати ліміт усіх tools за замовчуванням без відповідних evals.

### D06-07 — Версії, оновлення й disable

- [ ] Import/update показує semantic diff: added, removed, changed schemas/scopes/effects/targets.
- [ ] Нова версія не активує додаткові permissions; workflow review/publish головного TODO лишається authoritative.
- [ ] Native MCP server зі зміненою schema/hash не виконується як «майже та сама версія».
- [ ] Publish connector artifact окремо від секретів, із lockfiles, immutable image digest та release notes згідно з D01.
- [ ] Disable connector зупиняє нові claims, зберігає in-flight outcome й пояснює affected cases оператору.
- [ ] Recovery/rollback не відновлює відкликані credentials чи старі approvals.
- [ ] Явно вказати support tier: bundled, community, experimental. Community artifact не отримує автоматичний privileged доступ.

## 4. Карта файлів

| Поточна або proposed область | Робота |
| --- | --- |
| `apps/api/src/integrations/` | Публічний connector boundary, compatibility/inspection |
| `apps/mcp-openapi/` після головного TODO | Starter adapters, importer diagnostics, manifest metadata |
| `apps/api/tests/integrations-mcp.test.ts` | Reuse поведінкових сценаріїв без втрати поточних assertions |
| Proposed `packages/connector-contract/` або test package | Schema, fixtures, conformance runner; без доступу до DB internals |
| Proposed `examples/connectors/` | Відтворювані synthetic upstream systems |
| `docs/integrations-runtime.md`, `docs/EXTERNAL_DATA.md` | Реальні можливості, відмінність storage/knowledge/business connectors |
| Proposed `docs/connectors/authoring.md` | Contributor guide, lifecycle і version matrix |

Вибрати одну ownership точку contract schemas. SDK з D04, manifest і conformance runner не повинні мати три незалежні копії одного визначення.

## 5. Acceptance matrix

| Сценарій | Доказ готовності |
| --- | --- |
| Чисте встановлення reference connector | Окремий developer проходить guide без правок core |
| Другий business/customer | Чужі IDs не читаються і не змінюються |
| API повернув nested/private data | У model response залишилась тільки reviewed projection |
| Timeout після запису | `unknown`, provider reference/reconciliation, жодного blind retry |
| Оновлена schema або scope mapping | Execution заблоковано до review/activation |
| Вимкнена операція | Не присутня в model catalog і не викликається напряму |
| Connector повернув rate limit | Bounded documented result, без масового retry storm |
| Native MCP і FastMCP variants | Обидва проходять ту саму contract suite |
| Великий tool catalog | Показані вимірювання selection accuracy/latency/cost |
| Стара версія образу | Явний compatible/unsupported outcome, без мовчазного downgrade |

## 6. Порядок виконання та Definition of Done

1. Стабілізувати manifest і authoring guide на основі реалізованого головного TODO.
2. Винести conformance suite і підготувати runnable Orders fixture.
3. Підключити другий бізнесовий сценарій та перевірити часткові відмови.
4. Додати inspection/diagnostics, curated reads і вимірювання catalog selection.
5. Опублікувати versioned example artifacts, compatibility report та upgrade notes.

Done: два різні сценарії інтегровані без редагування harness, працює documented test suite, видимі обмеження та гарантований спосіб disable/recovery. Кількість connector logos або згенерованих tools не є критерієм готовності.

Нецілі цього етапу: marketplace з автоматичною інсталяцією чужого коду, універсальний SQL tool, довільні agent scripts і обіцянка повної сумісності з будь-якою OpenAPI-специфікацією. Підтримувані формати й можливості визначаються перевіреним contract.
