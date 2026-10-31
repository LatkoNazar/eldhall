# D07 — Автентифікація, ізоляція бізнесів і життєвий цикл даних

**Пріоритет:** P0 для реальних клієнтських даних; командні ролі — P1, корпоративний SSO — P2.  
**Передумови:** головний `TODO.md`; узгодження DTO/auth schemes D04-01; міграції/restore contract D03. Scoped keys/session exchange D07 реалізуються до production SDK examples D04-05/06, повне завершення D04 не є передумовою.
**База огляду:** `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01.  
**Результат:** бізнес може інтегрувати агент у власний продукт, видати обмежений доступ і відкликати його без зміни загального admin token.

## 1. Поточна основа

[core/auth.ts](../apps/api/src/core/auth.ts) уже має fail-closed `staffTokenMatches` і timing-safe порівняння. [support/routes.ts](../apps/api/src/modules/support/routes.ts) генерує opaque customer sessions, а customer handlers отримують identity з `X-Customer-Session`. Операторський bearer представляє одного deployment-wide principal, audit записує `operator:staff`; `/team` прямо повідомляє, що invites та role changes не підтримуються.

Це робоча модель одного адміністратора self-host deployment. Вона ще не дає окремих прав сервісному інтегратору, оператору конкретного бізнесу та користувачу, який лише переглядає звернення. `businessId` у query вибирає дані, але сам по собі не є доказом права на них.

[docs/SECURITY.md](../docs/SECURITY.md) містить історичні findings; перед змінами звірити їх зі свіжим кодом. Зокрема, не повторювати старе твердження про self-declared audit actor: поточні handlers задають його на сервері.

Цей план розширює доступ до продукту. Permissions на бізнесові операції з головного TODO залишаються окремим рівнем.

## 2. Цільовий контракт principal

Кожен захищений request отримує server-owned principal:

```ts
type Principal = {
  id: string;
  kind: "deployment_admin" | "operator" | "service" | "customer";
  businessIds: string[];
  capabilities: string[];
  sessionId?: string;
  customerId?: string;
  authVersion: number;
};
```

Це запропонований тип, а не наявний API. Джерело полів — перевірена credential/session record. Client payload не може змінити `kind`, права або належність до бізнесу.

| Principal | Мінімальні повноваження |
| --- | --- |
| Deployment admin | Bootstrap, businesses, інтеграції, керування service credentials |
| Business operator | Кейси свого бізнесу, відповіді, дозволені approve/execute |
| Service integration | Явно видані API capabilities для конкретного business |
| Customer session | Власні кейси/повідомлення; без policy, proposals та internal knowledge |

Для невеликого self-host deployment можна лишити один bootstrap admin. Базовий продукт не повинен вимагати зовнішній identity server лише для локального запуску.

## 3. D07-01 — Service credentials замість передачі admin token

- [ ] Додати серверне створення/перелік/revoke service keys із business scope та allowlist capabilities, наприклад `customers:provision`, `cases:read`, `messages:write`.
- [ ] Показувати secret лише один раз при створенні; зберігати verifier/hash, public key ID, назву, creation/expiry/revocation metadata.
- [ ] Використовувати криптографічно випадкові tokens; не повторювати пароль користувача чи provider key.
- [ ] Окремо визначити ключ для host backend, credential MCP sidecar і model provider secret. У них різні повноваження.
- [ ] Додати ротацію з обмеженим overlap старого й нового key; revoke набирає чинності для нових requests.
- [ ] Audit має показувати конкретний service principal, а не спільне `staff`.
- [ ] Обмежити доступ key-management endpoints deployment admin; ключ не може сам розширити власні capabilities.

**Готово:** приклад інтеграції D04 працює з business-scoped key; цей key не читає іншого бізнесу й не може погодити фінансову дію.

## 4. D07-02 — Прив'язати customer identity до host application

Цільовий потік: автентифікований користувач → backend бізнесу → session exchange в Eldhall → короткоживуча customer session.

- [ ] Ввести стабільне відображення `businessId + externalCustomerId → customerId` з uniqueness у БД.
- [ ] Provision/session exchange доступний лише service principal із потрібним scope. Browser не передає довільний customer ID як доказ identity.
- [ ] Задокументувати session expiry, refresh/reissue, revoke, logout і поведінку активного turn після revoke.
- [ ] Customer session не містить operator capabilities; зміна plan/membership читається із trusted state.
- [ ] Зберегти ідемпотентність provisioning, щоб login retry не створював нових customers.
- [ ] Для першої реалізації використати opaque sessions і DB lifecycle. JWT/OIDC bridge додавати лише за окремим перевіреним contract.
- [ ] Якщо підтримується browser cookie mode, явно визначити same-site, CSRF та origin checks; header-based mode документувати окремо.
- [ ] Не передавати bearer у URL, query string або аналітичні події.

**Готово:** host-app example входить двома користувачами, отримує різні sessions, і спроби прочитати чужий case дають відмову.

## 5. D07-03 — Авторизація кожного ресурсу

- [ ] Ввести спільні `requireCapability` та `assertBusinessAccess` перед handler/service work.
- [ ] Перевіряти business і customer ownership для cases, messages, proposals, executions, knowledge, classifications, integrations, Insights та exports.
- [ ] Списки, пошук, metrics і bulk APIs фільтрувати на рівні repository query, а не завантажувати все й приховувати на frontend.
- [ ] Approve та execute можуть мати різні capabilities; actor отримувати тільки з principal.
- [ ] Зміна ролі, membership чи revoke має блокувати наступний execute навіть за вже створеним approval snapshot.
- [ ] Snapshot/lease містить auth revision. Revoke session/membership перевіряється перед новим tool dispatch і перед final delivery/stream event; уже dispatched write має recorded outcome в ledger навіть після revoke і не стає автоматично скасованим.
- [ ] Наявні hard business guards з головного TODO діють поверх API authorization.
- [ ] Історичний jobs API із optional-token semantics ізолювати від support credentials і явно описати його availability у production.
- [ ] Для недоступних об'єктів визначити узгоджену 404/403 семантику в D04; уникнути витоку існування чужого об'єкта.
- [ ] Повторити перевірки для streaming/events/webhook configuration із D05.

Перший реліз може підтримувати deployment admin + scoped service keys. Публічна обіцянка незалежних операторів різних бізнесів потребує завершеного business-scoped authorization у всіх відповідних маршрутах.

## 6. D07-04 — Retention, export та видалення

- [ ] Інвентаризувати персональні дані: PostgreSQL, message history, audit payloads, DSH native sessions, KB chunks/embeddings, external caches, logs, exports і backups.
- [ ] Додати документовані retention settings за класами даних; початкові значення пояснити й показати в effective config.
- [ ] Додати customer/case export через scoped admin API з bounded asynchronous job для великого обсягу.
- [ ] Видалення має бути versioned/idempotent operation із preview count та audit; не використовувати загальний demo reset.
- [ ] Відкликання session/knowledge зупиняє нове використання, а фізичне видалення може бути асинхронним із видимим станом.
- [ ] Після видалення прибрати пов'язані runtime sessions, chunks, indexes і cached representations; перевірити, що вони не відновляться через старий bootstrap.
- [ ] Фізичне видалення гарантувати лише для сховищ під керуванням Eldhall. Для read-only external Qdrant та інших систем застосувати local exclusion/tombstone, припинити використання й описати звернення до source owner; remote deletion і model-provider copies потребують окремого підтримуваного механізму.
- [ ] Окремо визначити мінімальні execution/idempotency records, потрібні для запобігання повторній зовнішній дії. Видалення чату не повинно дозволити повторний refund.
- [ ] Backups мають власну retention/restore процедуру; не обіцяти миттєве стирання історичних backup objects.
- [ ] У restore drill D03 перевіряти повторне застосування revocation/deletion watermarks.
- [ ] Не називати систему автоматично відповідною конкретному законодавству: задокументувати фактичні функції й відповідальність deployment owner.

## 7. D07-05 — Секрети, browser session і transport

- [ ] Секретні значення лишаються у server-side env/secret files; support diagnostics показують тільки presence/source/redacted metadata.
- [ ] Перевірити API, Caddy та worker logs на `Authorization`, `X-Customer-Session`, cookies, provider headers і tool payloads.
- [ ] Визначити підтримувану proxy-trust конфігурацію; forwarded client IP приймати лише від явно довіреного proxy.
- [ ] Для hosted operator UI замінити постійне ручне копіювання deployment-wide token належним session flow, коли введені operator accounts.
- [ ] Cookie/session і CSP/headers перевірити на фактичному reverse proxy; не вважати React escaping повною XSS-моделлю захисту.
- [ ] За замовчуванням локальний quickstart доступний на loopback; public deployment має задокументований TLS/origin configuration.
- [ ] MCP/webhook egress allowlists не контролюються customer/model output.

Довідка для реалізації session lifecycle: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Конкретні параметри TTL і cookie policy обрати за deployment mode та перевірити тестами.

## 8. File map і міграція

| Місце | Зміна |
| --- | --- |
| `apps/api/src/core/auth.ts` | Principal resolution, token verification |
| Новий `modules/identity/` | Keys/sessions/memberships repository, service, routes |
| `modules/support/routes.ts`, Insights/KB/integration routes | Scoped authorization |
| `modules/support/contracts.ts` і stores | External identity mapping, revoke/version metadata |
| Наступні SQL migrations | Credentials, sessions, memberships, lifecycle records |
| `apps/frontend/src/lib/api.ts` і operator entry | Session flow, permission-aware UI |
| `infra/Caddyfile*`, frontend Caddyfile, logging config | Transport/redaction |
| D03/D12 docs | Retention, restore та knowledge deletion |

Почати з backward-compatible verifier: чинний bootstrap token представляє deployment admin. Додати нові scoped credentials, мігрувати приклади/SDK, після цього описати deprecation слабших способів інтеграції. Не скидати customer sessions без плану міграції.

## 9. Обов'язкові перевірки

- [ ] Матриця principal × capability × own/foreign business/resource; перевірити read і write, списки та streams.
- [ ] Forged principal/body business ID не змінює authorization.
- [ ] Expired/revoked/rotated key поводиться за документованим contract.
- [ ] Parallel session exchange не створює дубль customer.
- [ ] Membership change між approve й execute блокує виконання.
- [ ] Customer не отримує operator analysis/proposals/private KB.
- [ ] Видалення прибирає model-accessible copies, але зберігає необхідний захист від повторної action.
- [ ] Redacted diagnostic bundle не містить credentials чи текстів розмов за замовчуванням.
- [ ] Чинні staff-auth/customer isolation tests продовжують проходити.

**Definition of done:** documented threat/identity boundaries, negative integration tests на реальній PostgreSQL, migration/rollback evidence, приклад host backend без admin token у browser. Повний SSO та довільні role editors не є блокером базового self-host release.

