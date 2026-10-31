# D02 — Встановлення, bootstrap і зрозуміла конфігурація

**Пріоритет:** P0 для публічного self-hosted користування.  
**Передумови:** завершений [основний TODO](https://github.com/LatkoNazar/eldhall/blob/858985f38b82e4e26dafb563e4e794ff01cc9196/TODO.md); image/manifest contract із [D01](01-dockerhub-and-release-pipeline.md).  
**Результат:** розробник проходить шлях «завантажив реліз → налаштував → створив бізнес → отримав першу відповідь» без читання внутрішнього коду.  
**Baseline:** `858985f38b82e4e26dafb563e4e794ff01cc9196`; запропоновані нижче CLI commands ще потрібно реалізувати.

## 1. Підтверджена основа й прогалини

[Standalone Compose](../deploy/support.compose.yaml) уже має PostgreSQL, Redis, одноразову migration, API/worker та optional UI, а [external-db recipe](../deploy/support.external-db.compose.yaml) дозволяє окремий PostgreSQL. [Implementation guide](../docs/implementation.md) містить headless bootstrap через API, пояснює customer session, volumes і config overlay.

Водночас інструкція потребує ручного створення `.env.support`, вибору кількох recipes і локального `--build`. [init-env.py](../scripts/init-env.py) безпечно генерує secrets, використовує exclusive create і permissions `0600`, але орієнтований на starter: створює Umami/landing variables, не формує цілісний support installation bundle.

[core/config.ts](../apps/api/src/core/config.ts) уже перевіряє provider/store/runtime combinations і production secrets. CLI `doctor`, єдиного support bootstrap та canonical configuration reference в перевіреному дереві немає. [Frontend Dockerfile](../apps/frontend/Dockerfile) використовує build-time public config; потрібно перевірити, які з цих значень справді потрібні готовому універсальному UI image.

## 2. Обіцяний шлях користувача

| Варіант | Кому потрібен | Що запускається |
| --- | --- | --- |
| Local evaluation | Зрозуміти продукт без provider key | Explicit rules/demo mode, синтетичні дані, loopback ports |
| Persistent self-hosted | Перший реальний бізнес | PostgreSQL, Redis, migrate, API, worker; UI optional |
| Existing infrastructure | Компанія з PostgreSQL/Redis | Ті самі server roles із явно заданими external dependencies |
| Embedded/headless | Компанія зі своїм frontend | API/worker, server-to-server identity/bootstrap; bundled UI не потрібен |

Demo має бути явно позначеним. Його успіх не є перевіркою якості LLM. Production bootstrap не створює фіктивних клієнтів, замовлень або платежів.

### D02-01 — Canonical installation bundle

- [ ] Дати в GitHub Release готовий bundle, який не залежить від git checkout або source-relative build paths.
- [ ] У bundle включити `compose.yaml`, locked image references/release manifest, `config.example.json`, коротку інструкцію, checksums та command reference.
- [ ] Звести user path до підтримуваного Compose entry point з явними overlays/profiles для UI, MCP і external dependencies.
- [ ] Вибір external PostgreSQL не повинен паралельно створювати непотрібну local database. Те саме правило застосувати до external Redis.
- [ ] Підтримати декілька незалежних installations через stable project ID, окремі volumes, ports і queue/key namespaces.
- [ ] Зміна project name після першого запуску має видавати пояснення про інший storage identity, а не виглядати як «дані зникли».
- [ ] README містить одну рекомендовану командну послідовність для кожного сценарію, а developer build instructions винесені окремо.

### D02-02 — CLI усередині server image

Реалізувати один невеликий Node CLI без нового runtime на host. Цільові commands:

| Command | Контракт |
| --- | --- |
| `eldhall help` / `version` | Працює без БД, Redis або LLM key |
| `eldhall init` | Створює private env/config і installation metadata |
| `eldhall config validate` | Перевіряє формат/сумісність без mutation |
| `eldhall doctor` | Показує зрозумілі readiness/connection results |
| `eldhall migrate status` / `migrate` | Окрема керована migration operation |
| `eldhall bootstrap` | Ідемпотентно створює перший бізнес/admin setup |
| `eldhall api` / `worker` | Запускає відповідний foreground process |

- [ ] Назви команд — майбутній інтерфейс; до реалізації не показувати їх як працездатний quickstart.
- [ ] CLI працює через published image, наприклад `docker run --rm <server-image-ref> eldhall help`. Exact entrypoint/argv контракт затвердити й протестувати.
- [ ] Entrypoint передає сигнали основному процесу; не запускає worker/DB як приховані background processes.
- [ ] `init` не перезаписує наявний config, volumes, keys або project identity. Для rotation є окрема явна operation.
- [ ] Згенеровані secrets не друкуються в stdout. Команда повідомляє шлях/permissions і наступний крок.
- [ ] Bind-mounted output directory працює для non-root container UID; не вимагати `chmod 777`.
- [ ] Перевірити Linux, Docker Desktop з Linux containers на macOS/Windows і paths із пробілами. Обмеження конкретного host задокументувати.

### D02-03 — Один зрозумілий configuration contract

- [ ] Розділити infrastructure config, credentials та business settings. Business permissions/revisions залишаються authoritative у PostgreSQL згідно з головним TODO.
- [ ] Задокументувати precedence infrastructure values: explicit environment → mounted config → documented defaults. CLI не приймає secrets як видимі process arguments.
- [ ] Для секретів підтримати узгоджені `*_FILE` references. Одночасне задання inline secret і file source відхиляти як ambiguity.
- [ ] Додати schema/config version, валідацію невідомих ключів у JSON і actionable errors із шляхом поля без credential value.
- [ ] Згенерувати reference з реальної schema: тип, default, required condition, restart requirement, secret/public classification.
- [ ] Усі sample values мають проходити validation; production відхиляє відомі example credentials.
- [ ] Password/URL з `$`, `#`, quotes, spaces і Unicode не ламаються через shell interpolation. Env file не виконується як shell script.
- [ ] Не змінювати business policy старішим startup-файлом після operator edit.
- [ ] Ввести redacted config view: effective source і наявність значення, але не токени, паролі чи повний connection URL.
- [ ] Runtime config UI потребує лише public browser-safe значень. Credentials завжди лишаються server-side.
- [ ] Якщо UI потребує deployment-specific public URL, додати контрольований runtime configuration endpoint/file; збірка власного образу для зміни домену не повинна бути стандартним кроком.

[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) монтуються як файли; application має сам підтримувати читання такого credential source. Наявність `secrets:` у Compose не додає автоматично `*_FILE` behavior у Node.

### D02-04 — Bootstrap без ручного SQL

- [ ] Створення першого бізнесу має explicit installation ID та idempotency key; повтор команди повертає наявний результат.
- [ ] Підтримати interactive local flow і noninteractive flags/config для CI/IaC без виведення secrets.
- [ ] Bootstrap не перезаписує існуючих користувачів, policy, connector approvals чи KB.
- [ ] Customer identity задає host application через trusted backend path. Browser widget не отримує operator token.
- [ ] Чітко розділити deployment-wide bootstrap operator bearer і майбутні scoped service accounts; розширення auth виконується у відповідній auth-задачі.
- [ ] Дати синтетичний smoke customer/knowledge source, який створюється тільки за explicit test/demo flag.
- [ ] Після bootstrap показати checklist фактично готових компонентів: store, worker, model configuration, knowledge, connector state.
- [ ] Підтвердження provider key робити окремою explicit діагностикою; звичайний config validation не запускає платну model generation.

### D02-05 — Doctor, що пояснює збій

`doctor` має окремі рівні: local/static checks; dependency connectivity; optional provider/connector checks. Список результатів включає check ID, status, safe detail та конкретну corrective action.

- [ ] Перевіряти image/version consistency між API/worker, config version, required schema і доступність mounted artifacts.
- [ ] Відрізняти неправильний пароль БД від недоступного host, missing migration від відсутнього worker, worker heartbeat від фактичного turn completion.
- [ ] Перевіряти runtime directory permissions, disk free space і підтримувану platform без читання секретів у log.
- [ ] Пояснювати, що `localhost` усередині контейнера — цей контейнер, а не PostgreSQL на host.
- [ ] Відрізняти API process liveness, product readiness та optional integration availability.
- [ ] При недоступному optional connector загальний результат показує degraded component; не оголошувати всі сервіси готовими лише через HTTP 200 health.
- [ ] Виводити machine-readable JSON для CI з тими самими reason codes.
- [ ] Support bundle містить sanitized versions/config shape/statuses, без chat contents, authorization headers або native session dump.
- [ ] Timeout кожної діагностики обмежений; `doctor` не зависає через недоступний зовнішній сервер.

### D02-06 — Production recipe і сумісність залежностей

- [ ] Зберегти loopback binding як default для host ports; окремо описати existing reverse proxy, TLS і allowed hosts.
- [ ] PostgreSQL/Redis не публікувати на host за замовчуванням.
- [ ] Додати конфігурацію external dependency TLS/CA тільки з перевіреною бібліотечною підтримкою; не вимикати certificate verification заради успішного підключення.
- [ ] Перевірити schema isolation. Зараз migrations використовують `public.jobs`/`alembic_version` і можуть конфліктувати з чужим app database; до завершення відповідної storage-задачі рекомендувати виділену DB.
- [ ] Native sessions, продуктова БД, imported manifests і cache storage мають явні volume paths та ownership.
- [ ] Розділити migrate credential і runtime credential, де підтримуваний deployment це дозволяє; runtime не потребує постійних DDL прав.
- [ ] Дати measured resource guidance для невеликої ARM VM та local evaluation, окремо idle і active turns. Значення RAM/CPU опублікувати після benchmark.
- [ ] Задокументувати мінімальні перевірені Docker/Compose versions; не підтримувати можливості новішої Compose без чіткого minimum version.
- [ ] `docker compose down` зберігає дані; destructive reset із volumes — окрема explicit demo/decommission operation.

## 3. Файли і етапи

Спочатку canonical bundle та image CLI; потім schema reference/doctor; далі bootstrap; наприкінці multi-host clean-install tests. D01 відповідає за published images, D02 — за використання їх новою людиною.

Основні місця: `deploy/`, `scripts/init-env.py` як джерело збережених гарантій, новий `apps/api/src/cli/`, `core/config.ts`, bootstrap/admin routes, `apps/frontend/Dockerfile`/runtime config, README та installation guide. Не створювати другий незалежний parser конфігурації для CLI.

## 4. Definition of Done і докази

- [ ] Людина, яка не писала код, встановила реліз із release bundle без source checkout, local build і ручного SQL.
- [ ] Збережено час до першої відповіді, перелік виконаних кроків і місця, де знадобилась допомога; це baseline, не маркетинговий benchmark.
- [ ] Repeat init/bootstrap не змінює secrets і не дублює бізнес.
- [ ] Missing key, invalid config, wrong architecture, port conflict, DB TLS error, missing migration і unwritable volume дають зрозумілий diagnostic result.
- [ ] Native model fixture та explicit demo mode тестуються окремо.
- [ ] Restart зберігає cases, policy, approvals, knowledge та installation identity.
- [ ] Дві installations на одному host не читають одна одну й не ділять queue/volumes.
- [ ] Quickstart і Docker Hub README перевіряються проти конкретного release manifest; копіювання їхніх команд не вимагає прихованих локальних файлів.

One-click cloud marketplace, Kubernetes installer та desktop app не є умовами завершення D02.

