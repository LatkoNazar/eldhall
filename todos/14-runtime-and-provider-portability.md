# D14 — Заміна моделей/runtime без зміни бізнесового ядра

**Пріоритет:** P0 для чесного support matrix; P1 для взаємозамінних adapters; CLI/subscription experiments — P2.  
**Передумови:** головний `TODO.md`; execution invariants D08; evaluations D11.  
**База огляду:** `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01.  
**Результат:** deployment owner обирає підтримуваний provider/model/runtime, а permissions, approval і business execution поводяться однаково.

## 1. Наявна точка розширення

[AgentModel](../apps/api/src/modules/agent/model.ts) уже має `provider`, `model` та `decide(ctx, signal)`; є `ScriptedModel` і `RulesModel`. [factory.ts](../apps/api/src/modules/support/factory.ts) підключає DSH або rules. [dsh-model.ts](../apps/api/src/runtime/dsh-model.ts) підтримує provider routes `google/openai/anthropic/local`.

[profile.ts](../apps/api/src/runtime/profile.ts) pin-ить DSH version, контролює bundle/tool allowlist, child environment і native sessions. [config.ts](../apps/api/src/core/config.ts) окремо має model provider, runtime, base URL, model ID та keys. Поточні runtime tests перевіряють реальний DSH через fake compatible endpoint.

Точки заміни вже є. Потрібно зробити явними capability contract, session compatibility, verification matrix та поведінку при помилках. Наявність enum value або OpenAI-like URL не доводить сумісність будь-якої моделі.

## 2. D14-01 — Відокремити runtime, provider і model configuration

- [ ] Описати `runtimeAdapter`: хто виконує agent loop і як він повертає tool requests/results.
- [ ] Описати `modelRoute`: provider, model ID, endpoint, credential reference, explicit data-sharing policy.
- [ ] Business tools/permissions/case state належать application core; runtime не створює власний action execution path.
- [ ] Ввести versioned model/runtime configuration та показувати її у authenticated capabilities/doctor.
- [ ] Unknown runtime/provider/model capabilities давати actionable startup/admission error.
- [ ] Default route визначити з verified matrix, а не з випадкового newest model alias.
- [ ] Local endpoint не означає наявність LLM всередині Docker image; його deployment і ресурси документувати окремо.
- [ ] Не змішувати conversation model, classifier і embedding provider в один непрозорий setting.

## 3. D14-02 — Capability contract

Запропонована декларація adapter:

```ts
type RuntimeCapabilities = {
  structuredDecision: boolean;
  toolCalls: boolean;
  cancellation: boolean;
  resumableSessions: boolean;
  tokenUsage: "reported" | "partial" | "unavailable";
  toolSchemaDialect: string;
  adapterVersion: string;
};
```

- [ ] Мінімальний support contract: bounded decision, controlled tools, cancellation/deadline, validated arguments, deterministic error mapping.
- [ ] Optional capabilities не симулювати фіктивними даними; unavailable usage залишається unknown.
- [ ] Визначити допустимий schema subset і перетворення для provider, не послаблюючи backend validation.
- [ ] Якщо model не підтримує required tools/structured output, відмовити в activation або ввімкнути явно обмежений read-only mode з окремим label.
- [ ] Runtime не отримує generic shell/filesystem tools, business API credentials чи raw privileged clients.
- [ ] Provider error має категорію: authentication/configuration, rate limit, unavailable, timeout, invalid output, unsupported capability.
- [ ] SDK/API errors для користувача не містять credential чи raw upstream response.
- [ ] Streaming, якщо доданий, не публікує action success до persisted outcome.

## 4. D14-03 — Contract tests для adapter

Спільна suite має запускатися для кожного заявленого runtime, незалежно від model quality:

- [ ] Валідний decision, malformed JSON, missing required fields, oversized output.
- [ ] Allowed tool, unknown tool, forged integration, wrong schema і повторні tool attempts.
- [ ] `auto/ask/deny` та pending result із головного TODO.
- [ ] Cancellation під час generation і tool call; cleanup child process/resources.
- [ ] Provider timeout/rate limit; bounded retries всередині загального deadline.
- [ ] Context/policy/source revision change не повертає stale final output.
- [ ] Runtime recovery не повторює already dispatched business action.
- [ ] Секрети не з'являються у model-visible prompt/tools, а модель не може задавати або підміняти trusted scope bindings. Потрібний бізнесовий контекст, ім'я чи plan передаються лише через явну мінімальну дозволену проєкцію.
- [ ] Usage reporting, якщо supported, має чіткі units та accounting.
- [ ] Session reset/resume відповідає задекларованим можливостям.

Першим adapter лишити DSH. Другий додавати, коли є конкретний потребуючий сценарій, і порівняти через однакові D11 fixtures; два runtime не потрібні лише заради кількості.

## 5. D14-04 — Session portability і version upgrades

- [ ] PostgreSQL product history є authoritative; native runtime files — versioned execution context.
- [ ] Повторний запуск того самого runtime/model може використовувати перевірений native resume.
- [ ] Зміна runtime/provider/model не копіює чужий native session format.
- [ ] Для переключення формувати контрольований bounded product snapshot із чинними policy, facts і provenance.
- [ ] Всі persisted outcomes/unknown actions залишаються у core ledger; зміна runtime не «обнуляє» виконані дії.
- [ ] Version gate із поточного `wasSessionStarted` розвинути до migration/reset policy з audit і зрозумілим doctor output.
- [ ] Під час rollout перевірити supported mixed-version window або вимагати drain.
- [ ] Session storage/locking/topology узгодити з D08, backup/restore — з D03.
- [ ] Не заявляти повний перенос model memory між provider, якщо зберігається лише продуктова історія.

## 6. D14-05 — Fallback і provider budgets

- [ ] Fallback route задається явно deployment owner; перемикання на іншого provider не має приховано змінити одержувача customer data.
- [ ] Розрізняти retry того самого запиту, fallback до іншої моделі та rules/human handoff.
- [ ] Ніколи не повторювати бізнесову side effect лише через повторний model attempt.
- [ ] Загальний deadline та per-provider retry budget не множаться при каскаді fallback.
- [ ] Circuit breaker/backoff прив'язати до provider error category; invalid config не retry нескінченно.
- [ ] Rate/cost quotas за deployment/business доповнюють admission control D08.
- [ ] При вичерпанні budget дати чесний стан і handoff; не вигадувати відповідь від успішної моделі.
- [ ] Record actual provider/model/adapter/config revision для кожного run.
- [ ] Не вводити автоматичний cost-based routing до наявності usage evidence й D11 quality baselines.

## 7. D14-06 — API credentials і можливі CLI/subscription adapters

Початковий production contract — задокументовані API credentials або сумісний self-host model endpoint. Підтримка підписок через Claude/Codex чи інший CLI є окремою перевірюваною можливістю, а не наслідком наявності API adapter.

- [ ] Для кожного бажаного CLI adapter спершу перевірити офіційні SDK/headless/auth механізми, актуальні умови використання й поведінку rate limits.
- [ ] Записати verified/unsupported/experimental status і дату перевірки; не обіцяти, що будь-яка персональна підписка придатна для сервісу сапорту.
- [ ] Використовувати підтримуваний structured protocol/SDK, коли він є. Парсинг довільного terminal text не має бути stable API.
- [ ] Interactive login/setup виконує operator; runtime не дістає credentials із випадкових домашніх каталогів.
- [ ] Окремо продумати isolation/account ownership для кожного deployment; не змішувати особисті сесії різних користувачів.
- [ ] CLI adapter мусить пройти той самий bounded tool/permission/cancellation suite. Якщо неконтрольовані built-in tools неможливо вимкнути, adapter не допускається до production customer data; дослідження дозволене лише в ізольованому synthetic environment.
- [ ] Packaging experimental CLI dependencies відокремити від мінімального production image.
- [ ] Не переносити CLI «approve all» у application permissions. Business policy залишається єдиним execution gate.

Цей розділ — дослідницький gate, а не інструкція обходу авторизації чи підтвердження поточної підтримки конкретної підписки.

## 8. D14-07 — Support matrix і перевірка оператором

| Поле матриці | Приклад значення |
| --- | --- |
| Runtime adapter | DSH, pinned adapter revision |
| Provider/model | Явний перевірений provider + model ID |
| Protocol conformance | Passed / unsupported / untested |
| Live semantic eval | Report ID або not run |
| Resume behavior | Native / fresh product snapshot |
| Platform | Перевірена CPU architecture/image digest |
| Credentials | API / local endpoint / experimental supported login |
| Limitations | Відомі schema/streaming/usage restrictions |

- [ ] Оновлювати matrix лише за evidence.
- [ ] Doctor може перевірити конфіг без model call; live ping/eval — окрема явна команда з можливою вартістю.
- [ ] Release upgrade runtime dependency проходить protocol tests, session compatibility і live evaluation default route.
- [ ] Не приховувати fallback у UI/metrics; actual route доступний оператору.

## 9. File map, етапи та готовність

`modules/agent/model.ts`, `modules/support/factory.ts`, `core/config.ts`, `runtime/dsh-model.ts`, `runtime/profile.ts`, runtime tests, новий adapter contract module і `docs/providers.md`.

1. Формалізувати наявний DSH contract і matrix.
2. Додати conformance suite та session upgrade policy.
3. Додати explicit route/fallback/budgets.
4. Реалізувати один потрібний альтернативний adapter і порівняти.
5. CLI/subscription adapter виконувати окремо після перевірки його можливостей.

**Definition of done:** verified support matrix, відтворювані conformance tests, контрольований provider switch, відсутність обходу policy, прозорі usage/fallback states і задокументована session compatibility. Кількість підтримуваних runtime не є самостійною метрикою успіху.

