# Support Copilot

AI-копілот підтримки, який не лише відповідає, а **безпечно виконує дії**: розуміє намір і настрій клієнта, перевіряє реальні дані та політику бізнесу, пропонує конкретну дію, просить підтвердження людини й виконує її через backend із повним аудитом. Підтримує різні бізнеси через per-business policy та реєстр tools.

**MVP (працює):** сценарій «подвійне списання» — tool call `lookup_payments`, детермінований policy engine, refund лише після approval (прив'язаний до `argsHash`), захист від повторного виконання, чесна обробка збоїв, sentiment → пріоритет/тон/ескалація, audit trail, fallback без LLM.
**Симульовано:** платіжний провайдер (`SIM-RF-*`), реальні гроші не рухаються. **Roadmap:** реальні провайдери, SSO/RBAC, нові канали, RAG.

## Швидкий старт (без Docker)
```bash
cp .env.example .env
cd apps/api && npm ci && npm test
OPERATOR_TOKEN=development-operator-token npm run dev     # API :8000, in-memory store
cd apps/frontend && npm ci && npm run dev                  # http://localhost:5173/chat і /operator
```
LLM: у `.env` задай `LLM_PROVIDER=openai|google|anthropic` і відповідний ключ; без ключа працює детермінований `rules`-режим (позначається як fallback).

Документація: [архітектура](docs/ARCHITECTURE.md) · [API](docs/API_CONTRACTS.md) · [PRD і тест-план](docs/PRD.md) · [статус](docs/STATUS.md) · [командні промпти](docs/TEAM_PROMPTS.md) · [демо](docs/DEMO_SCRIPT.md). Ліцензія: обирається командою.

---

## Основа для змагання (starter)

React, TypeScript, Vite, Node.js/Fastify, PostgreSQL та BullMQ на Redis в одному репозиторії. `apps/api` містить Node.js/TypeScript API й worker, `apps/frontend` — застосунок, `apps/landing` — окремий статичний лендинг на TypeScript. Umami збирає маркетингові події у власну PostgreSQL-базу. Frontend і landing мають окремі production-образи. Docker Compose призначений для одного Linux VPS; CI перевіряє вебзбірки, реальну фонову задачу та аналітику перед деплоєм.

Сценарії й відео для команди зберігаються в [demos/](demos/README.md); великі медіафайли передаються через Git LFS. Основний backend залишається Python; Node.js доступний як [окремий варіант у Git](#варіанти-backend).

Робота з фічами через головного агента та окремі worktrees: [інструкція](FEATURE_WORKFLOW.md).

## Варіанти backend

`main` — основний варіант із Python/FastAPI та Celery. `codex/node-backend` — альтернативний варіант із Node.js/TypeScript API й BullMQ worker. Лендинг, frontend, Umami та demo-проєкт мають спільну основу. Цей README описує Node.js-варіант; після перемикання на `main` користуйся Python-командами README тієї гілки.

Збережи локальні зміни перед перемиканням і вибери потрібний варіант:

```bash
git switch main
# Або Node.js-варіант:
git switch codex/node-backend
```

Node.js-варіант включає узгоджені API, worker, Compose, CI й серверні скрипти. Для перенесення в інший проєкт забирай увесь diff варіанта або працюй з його гілкою: одного каталогу `apps/api` недостатньо.

Перехід між backend-варіантами передбачає зупинку стека. Перед використанням існуючої БД з іншим worker дочекайся завершення всіх queued/running задач і зупини попередній Compose-стек, зберігаючи volumes. Потім перебудуй та запусти повний стек за README обраної гілки; BullMQ-черга Node `jobs-transform-v1` у Redis має власні дані. [Межі сумісності БД і черг](docs/backend-variants.md).

## Новий проєкт із шаблону

Скопіюй шаблон у новий репозиторій. Для інфраструктури достатньо одного імені `PROJECT_NAME`, наприклад `booking`; глобальна заміна назв у коді не потрібна.
Ім'я має відповідати `^[a-z0-9]+(-[a-z0-9]+)*$` і містити не більше 63 символів: малі латинські літери, цифри, дефіси між частинами.

1. Скопіюй `.env.example` у кореневий `.env` і встанови `PROJECT_NAME=booking`. У шаблоні локальне ім'я за замовчуванням — `starter`.
2. У новому GitHub-репозиторії створи Actions Variable `PROJECT_NAME=booking`. Змінні та secrets не копіюються разом із вихідним кодом; налаштуй їх окремо за таблицею нижче.
3. Згенеруй окремий production-файл з тим самим ім'ям, щоб зберегти локальний `.env`:

   ```powershell
   python scripts/init-env.py --project-name booking --output .env.production
   ```

4. Підготуй сервер: `sudo bash bootstrap-ubuntu.sh <deploy-user> booking`. Типовий каталог — `/opt/apps/booking`; перенеси туди `.env.production` під ім'ям `.env` і налаштуй деплой за наступними розділами. Домен можна додати пізніше.

Без `--domain` і `--email` генератор створює production-конфіг із `ALLOWED_HOSTS=["localhost","127.0.0.1"]`, `CORS_ORIGINS=[]`, без `DOMAIN` та `ACME_EMAIL`. Якщо домен уже є, передай обидва параметри разом:

```powershell
python scripts/init-env.py --project-name booking --domain api.booking.example.com --email you@example.com --output .env.production
```

Генератор не перезаписує наявні файли. Не генеруй `.env` повторно для вже запущеної БД: збережи її credentials та API token, змінюючи потрібні параметри в наявному файлі.

`PROJECT_NAME` визначає Compose-проєкт і типові теги локальних образів `booking:local`, `booking-frontend:local` та `booking-landing:local`. `APP_IMAGE`, `FRONTEND_IMAGE` і `LANDING_IMAGE` можуть явно перевизначити відповідні образи; стандартний `COMPOSE_PROJECT_NAME` використовуй лише для ізоляції локальних worktrees. У production задай однаковий `PROJECT_NAME` у серверному `.env` і GitHub Variable та не передавай інші імена через shell або `COMPOSE_PROJECT_NAME`. Деплой перевіряє ефективне ім'я Compose з урахуванням стандартного пріоритету змінних і зупиняється до оновлення застосунку, якщо воно не відповідає очікуваному.

Обери ім'я до першого запуску: його зміна створює інші Docker-ресурси й volumes та не переносить наявні дані. Для кількох проєктів на одному сервері також признач окремі `APP_PORT`, `FRONTEND_PORT`, `LANDING_PORT`, `UMAMI_PORT`, домени й каталоги та використовуй спільний зовнішній proxy; одного різного імені недостатньо для уникнення конфліктів портів. Вбудований TLS Caddy призначений для одного активного проєкту на сервері й займає 80/443.

## Локальний запуск

Потрібні Docker з Compose v2.24+ та Git. Для Node поза контейнерами потрібен Node.js 24.15+ у межах 24.x. Python 3.10+ використовується тільки хостовими операційними утилітами (`init-env.py`, release guards/тести), його немає в runtime API/worker.

```powershell
Copy-Item .env.example .env
# Встанови PROJECT_NAME=booking у .env перед першим запуском.
docker compose -f compose.yaml -f compose.dev.yaml build
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres redis umami-db umami
docker compose -f compose.yaml -f compose.dev.yaml run --rm migrate
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait api worker frontend landing
```

Лендинг: http://localhost:5174, Umami: http://localhost:3001, застосунок: http://localhost:5173, API: http://localhost:8000/docs. Порти БД і Redis у dev доступні тільки на localhost. Vite автоматично оновлює React після змін `apps/frontend/`, API й worker стежать за змінами `apps/api/src/` через TypeScript watch. Для Docker bind mounts на Windows/macOS увімкнено polling кожні 500 мс (`API_WATCH_USE_POLLING`, `API_WATCH_INTERVAL`); на native Linux polling можна вимкнути. Після зміни залежностей перебудуй відповідний образ і перезапусти сервіс.

Для frontend поза Docker потрібен Node.js 24.15+ у межах гілки 24.x. Запусти backend за командами вище, але не запускай контейнер `frontend`, і в іншому терміналі виконай:

```powershell
cd apps/frontend
npm ci
npm run dev
```

Frontend використовує відносні `/api/*` та `/health/*`. У dev Vite передає ці запити на `http://127.0.0.1:8000`, у Compose — на `api:8000`. Для іншого локального backend задай `API_PROXY_TARGET` перед `npm run dev`. Порт Vite типовий `5173`; для контейнера його можна змінити через `FRONTEND_LOCAL_PORT` у кореневому `.env`. `VITE_*` та `PUBLIC_*` є публічними build-time значеннями: ніколи не передавай через них `API_TOKEN` чи інші секрети.

```powershell
$headers = @{ Authorization = "Bearer development-token-not-for-production" }
$job = Invoke-RestMethod http://localhost:8000/api/v1/jobs -Method Post -Headers $headers -ContentType application/json -Body '{"text":"hello","operation":"uppercase"}'
Invoke-RestMethod "http://localhost:8000/api/v1/jobs/$($job.id)" -Headers $headers
Get-Content -Raw apps/api/scripts/smoke.mjs | docker compose -f compose.yaml -f compose.dev.yaml exec -T api node --input-type=module -
```

`GET /health/live` перевіряє процес, `/health/ready` — PostgreSQL та Redis. Окремий Docker healthcheck worker перевіряє свіжість його heartbeat у BullMQ Redis DB; smoke також чекає виконання задачі. У production Swagger вимкнений, API задач захищено Bearer `API_TOKEN`. Не вбудовуй спільний API_TOKEN у публічний frontend: перед відкриттям застосунку для користувачів додай його власну автентифікацію.

## Структура та нові модулі

```text
apps/
  api/
    src/
      app.ts          # Fastify, маршрути, auth та dependency injection
      server.ts       # HTTP-процес на 8000
      worker.ts       # окремий BullMQ worker
      migrate.ts      # явний SQL runner зі schema compatibility guard
      core/           # конфіг, PostgreSQL, Redis/BullMQ, міграції
      modules/
        system/       # публічні health endpoints
        jobs/         # schema, service, repository
      scripts/worker-health.ts
    migrations/0001_jobs.sql
    tests/            # Node test runner та TypeScript
    scripts/smoke.mjs # standalone перевірка API й реальної фонової задачі
    package.json
    package-lock.json
    Dockerfile
  frontend/
    src/              # React, TypeScript та UI-тести
    package.json
    package-lock.json
    vite.config.ts    # dev proxy до backend
    Caddyfile         # static files, SPA fallback та API proxy
    Dockerfile        # Node для build/dev, Caddy для production
  landing/           # статичний Vite/TypeScript лендинг, окремий образ
packages/analytics/   # спільні події, атрибуція й безпечне підключення Umami
demos/                # джерела запису, MP4/SRT та QA для команди через Git LFS
infra/                # необов'язковий Caddy
scripts/              # deploy, rollback, backup, генерація env
.github/workflows/    # CI та деплой з main
compose*.yaml         # спільна інфраструктура всіх застосунків
.env.example          # спільна конфігурація середовища
```

Кожен застосунок має власні залежності, перевірки й Dockerfile. API, frontend та landing використовують власні `package-lock.json` і `npm ci`. Docker Compose, CI/CD і скрипти сервера спільні в корені репозиторію.

Для фічі створюй `apps/api/src/modules/<feature>/`, тримай прикладну логіку в service, SQL у repository, HTTP-маршрути реєструй через `app.ts`. Точки входу API та worker окремі; спільну логіку викликай через модульні сервіси. Перевірки архітектурних меж не автоматизовані.

Команди Node API/worker запускай з `apps/api`:

```powershell
cd apps/api
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Production entrypoints — `node dist/server.js`, `node dist/worker.js` і `node dist/migrate.js`. Dev-команди `npm run dev` та `npm run dev:worker` використовують TypeScript watch. `npm run migrate` працює після build.

Перевірки frontend запускай з `apps/frontend`:

```powershell
npm ci
npm --prefix ../landing ci
npm run lint
npm run typecheck
npm test
npm run build
```

Frontend integration-тест імпортує справжній landing-модуль, тому перед його typecheck/test встанови залежності обох вебзастосунків. CI виконує цей самий порядок із чистого checkout.

Production не запускає Vite dev/preview server: образ містить лише результат збірки й Caddy. `/` та адреси сторінок відкривають SPA, `/assets/*` віддає статичні файли, `/api/*` і `/health/*` передаються до Node API зі збереженням шляху. Відсутній API endpoint або asset повертає справжню помилку, а не HTML сторінки. `/frontend-health` перевіряє HTTP-сервер frontend; `/health/ready` — залежності backend.

Для Node поза контейнерами підстав у змінні середовища `POSTGRES_HOST`, `REDIS_HOST` значення `localhost` і фактичні host-порти; credentials читаються зі спільного `.env`. Контейнери використовують внутрішні DNS-імена сервісів. Із `apps/api/` виконай `npm run build`, `npm run migrate`, потім запусти API й worker в окремих терміналах (`npm start`, `npm run worker`). У Compose міграції запускаються окремим сервісом `migrate`.

Поточний runner перевіряє схему `0001_jobs` і може прийняти сумісну Python-базу цієї ревізії. Невідому ревізію або дрейф схеми він відхиляє. Зміни схеми потребують явного розширення runner/версій і перевірки переходу зі старої БД; autogenerate в цьому варіанті немає. Докладніше: [backend variants](docs/backend-variants.md). Команди Docker Compose та серверні скрипти запускай з кореня репозиторію.

## Перший серверний запуск без домену

Для першого релізу достатньо сервера й SSH-доступу. Frontend слухає лише `127.0.0.1:18001`, API — `127.0.0.1:18000` на сервері; доступ отримуємо через SSH-тунель. Домен, DNS і TLS не блокують налаштування CI/CD.

1. На Ubuntu без Docker: скопіюй `scripts/bootstrap-ubuntu.sh` і `scripts/project.sh` в одну директорію на сервері та запусти `sudo bash bootstrap-ubuntu.sh <deploy-user> booking` з неї. Користувач уже має існувати. Необов'язковий третій аргумент задає абсолютний каталог замість `/opt/apps/booking`; таке саме значення встанови в `DEPLOY_PATH`. Скрипт використовує офіційний Docker apt repository, не змінює DNS і firewall. Перепідключи SSH після додавання користувача до групи docker. На інших Linux встанови Docker Engine та Compose за офіційною інструкцією.
2. Створи приватний production env командою `python scripts/init-env.py --project-name booking --output .env.production`. Файл створюється з випадковими секретами та не перезаписує наявний. Перенеси його на сервер як `/opt/apps/booking/.env` з правами `600`; у GitHub паролі БД передавати не потрібно. На Windows NTFS додатково обмеж доступ до локального файлу своїм користувачем.
3. До появи домену не створюй `/opt/apps/booking/.use-caddy` і залиш GitHub Variable `PUBLIC_URL` порожньою. Вбудований smoke перевіряє API та фонову задачу на сервері без зовнішнього HTTPS.
4. Створи окремий SSH-ключ для GitHub Actions і додай його public key у `~/.ssh/authorized_keys` deploy-користувача. Приватний ключ додай у GitHub Secret, а резервну копію збережи у своєму менеджері паролів. Звір fingerprint сервера через довірений доступ; `DEPLOY_KNOWN_HOSTS` має містити відповідний запис `known_hosts`, а для нестандартного порту — `[host]:port`.
5. У Settings → Secrets and variables → Actions налаштуй `PROJECT_NAME`, відповідний архітектурі `RUNNER_LABEL`, доступ до сервера й secrets із таблиці нижче. Для власного каталогу задай `DEPLOY_PATH`; потім увімкни `DEPLOY_ENABLED=true`. Push у `main` або ручний запуск workflow для `main` зробить перший реліз.

| Тип | Назва | Значення |
| --- | --- | --- |
| Variable | `PROJECT_NAME` | `booking`; те саме ім'я, що в серверному `.env` |
| Variable | `RUNNER_LABEL` | для x86_64 — `ubuntu-24.04` (типово); для ARM64, зокрема Oracle Ampere — `ubuntu-24.04-arm` |
| Variable | `DEPLOY_ENABLED` | `true`, щоб автоматично деплоїти main |
| Variable | `DEPLOY_HOST` | IP або DNS сервера |
| Variable | `DEPLOY_USER` | SSH-користувач з Docker-доступом |
| Variable | `DEPLOY_PORT` | за замовчуванням `22` |
| Variable | `DEPLOY_PATH` | необов'язкова; за замовчуванням `/opt/apps/<PROJECT_NAME>`, для прикладу `/opt/apps/booking`; абсолютний шлях без пробілів |
| Variable | `PUBLIC_APP_URL` | обов’язкова публічна адреса застосунку для build-time CTA лендингу; для приватного доступу явно `http://localhost:18001` |
| Variable | `PUBLIC_UMAMI_SCRIPT_URL`, `PUBLIC_UMAMI_WEBSITE_ID`, `PUBLIC_UMAMI_DOMAINS` | URL скрипта та UUID створеного сайту Umami; без них збір подій вимкнено. Domains — необов'язковий перелік дозволених hostname |
| Variable | `LANDING_PUBLIC_URL` | необов’язкова HTTPS-адреса лендингу для перевірки після деплою |
| Variable | `PUBLIC_URL` | необов'язкова; без домену залиш порожньою, після налаштування HTTPS — `https://api.booking.example.com` |
| Secret | `DEPLOY_SSH_KEY` | окремий приватний ключ для Actions |
| Secret | `DEPLOY_KNOWN_HOSTS` | перевірений SSH host key сервера |

CI запускає Node API/worker lint, typecheck, unit tests і build, тести хостових Python-утиліт, перевірки frontend і landing, тести спільного analytics SDK та release-скриптів. Він збирає три образи, мігрує чисту БД, перевіряє маршрути frontend і виконує задачу через його proxy та справжню чергу. Обидва jobs, перевірка й деплой, використовують `RUNNER_LABEL` та збирають образи нативної архітектури runner: `linux/amd64` або `linux/arm64`. Обери ту саму архітектуру, що на VPS.

Деплой запускається лише після успішного CI для `main` та за ввімкненого `DEPLOY_ENABLED`. Перед збиранням релізних образів preflight перевіряє Docker/Compose на сервері, каталог і серверний `.env`, а також збіг архітектур сервера й runner. API, frontend і landing з тегом одного Git SHA передаються через SSH в одному архіві: серверу не потрібні GitHub registry credentials.

Після успішного релізу відкрий тунель із локального комп'ютера й залиш команду працювати:

```bash
ssh -N -L 18081:127.0.0.1:18001 user@server
```

Підстав свого SSH-користувача й сервер; ключ і порт можна задати через SSH config або відповідні параметри `ssh`. Якщо змінив `FRONTEND_PORT`, заміни кінцевий `18001` у тунелі. Відкрий [frontend](http://localhost:18081/) та [readiness через його proxy](http://localhost:18081/health/ready). Для прямого доступу до API використовуй окремий тунель на `APP_PORT`. Порти застосунків залишаються закритими для зовнішніх підключень.

## Додати домен пізніше

Відредагуй наявний `/opt/apps/booking/.env`, зберігаючи `PROJECT_NAME`, паролі БД/Redis та `API_TOKEN`. Додай або онови лише параметри домену:

```dotenv
DOMAIN=api.booking.example.com
ACME_EMAIL=you@example.com
ALLOWED_HOSTS='["api.booking.example.com","localhost","127.0.0.1"]'
CORS_ORIGINS='["https://api.booking.example.com"]'
```

Frontend і API працюють на одному origin, тому окремий CORS-дозвіл для них не потрібен. Якщо винесеш frontend на інший домен, вкажи його origin у `CORS_ORIGINS`. Не запускай генератор `.env` повторно: нові паролі у файлі не змінять credentials у вже створених volumes.

Якщо є host Nginx/Caddy, налаштуй TLS і такі самі маршрути, як у `infra/Caddyfile`: `/api`, `/api/*`, `/health`, `/health/*` — напряму на `http://127.0.0.1:18000` (`APP_PORT`) зі збереженням зовнішнього Host та HTTPS-схеми, решту — на `http://127.0.0.1:18001` (`FRONTEND_PORT`). Це дозволяє API правильно формувати абсолютні адреси й перенаправлення. Для proxy в контейнері підключи його до Docker-мережі `edge` та використовуй `api:8000` і `frontend:8080`: його localhost відрізняється від host.
Якщо 80/443 вільні, можна створити `/opt/apps/booking/.use-caddy`: наступний deploy підніме вбудований Caddy. Не запускай другий proxy на зайнятих портах.

DNS A має вказувати на сервер; AAAA додавай лише за робочого IPv6. Дозволь вхідні 80/443 у мережевих правилах сервера. Повтори деплой після зміни конфігурації; коли HTTPS готовий, встанови `PUBLIC_URL=https://api.booking.example.com`, щоб наступні релізи також перевіряли публічний endpoint.

## Релізи, відкат і дані

Сервер зберігає `.env` окремо від `releases/<sha>/`. Workflow викликає `deploy.sh <project-root> <git-sha> <project-name>`; скрипт перевіряє збіг переданого імені з ефективним ім'ям Compose і збереженими образами поточного релізу, якщо він існує. Деплой серіалізовано через `flock`; спочатку перевіряються залежності, потім перед оновленням наявного релізу робиться `pg_dump`, застосовуються міграції, оновлюються API/worker/frontend/landing і виконується smoke. Вбудований TLS Caddy направляє `/api/*` та `/health/*` прямо до API зі збереженням зовнішнього Host і HTTPS, решту — до frontend. Внутрішній proxy frontend дозволяє користуватися застосунком також через loopback-порт або SSH-тунель. Після успіху `current` вказує на реліз, `previous` — на попередній. Під час рестарту можлива коротка перерва. Це один VPS, без гарантії високої доступності.

```bash
project_root=/opt/apps/booking
backup_script="$(readlink -f "$project_root/current/scripts/backup.sh")"
bash "$backup_script" "$project_root"
# Keep the resolved script path when rolling back to a legacy backend-only release.
rollback_script="$(readlink -f "$project_root/current/scripts/rollback.sh")"
bash "$rollback_script" "$project_root"

# Команди керування поточним релізом
cd "$project_root/current"
export APP_IMAGE="$(cat image.ref)"
if [ -f frontend-image.ref ]; then export FRONTEND_IMAGE="$(cat frontend-image.ref)"; fi
if [ -f landing-image.ref ]; then export LANDING_IMAGE="$(cat landing-image.ref)"; fi
docker compose --env-file "$project_root/.env" -f compose.yaml -f compose.prod.yaml ps
docker compose --env-file "$project_root/.env" -f compose.yaml -f compose.prod.yaml logs --tail 100 -f api worker frontend landing
```

Backup і rollback беруть ідентичність Compose із серверного `.env`; rollback використовує збережені `image.ref`, `frontend-image.ref` та `landing-image.ref` відповідного релізу. Для старого релізу до додавання frontend веб-reference файли відсутні: відкат відновлює попередню схему з API без frontend. Його історичний `rollback.sh` не знає про новий frontend: для повернення на новий реліз повторно використай збережений абсолютний `$rollback_script` з прикладу, а не скрипт через змінений `current`. Після відкату на старий реліз збережений `$backup_script` також продовжує робити окрему копію Umami DB через `analytics-current`; історичний backup-скрипт через старий `current` про неї не знає. Додавання frontend і landing не потребує повторної генерації `.env`: типові порти `18001` і `18002`. Перед першим додаванням Umami внеси нові секрети в наявний `.env` за [інструкцією](docs/analytics.md), зберігаючи всі попередні credentials.

Відкат повертає узгоджені образи API/frontend/landing, але не схему БД. Umami має незалежний життєвий цикл і не понижується при відкаті застосунку; його база та поточний analytics-реліз зберігаються. Деплой автоматично пробує відновити попередні сервіси при помилці. Міграції повинні бути сумісні з попереднім кодом: додавання поля/таблиці окремо від видалення старого. Відновлення БД роби лише усвідомлено зі збереженої копії: воно замінює дані. Для перевірки архіву: `pg_restore --list <backup.dump>` у контейнері PostgreSQL.

PostgreSQL застосунку, окремий PostgreSQL Umami, Redis і Caddy мають постійні Docker volumes. Не виконуй `down --volumes` на сервері. Дані в `.env` застосовуються до користувачів PostgreSQL при першій ініціалізації: зміна пароля у файлі не змінить його у вже створеній БД. Redis використовує пароль, AOF з fsync everysec та `maxmemory-policy noeviction`. BullMQ queue/results/worker heartbeat розташовані у виділеній Redis DB2, prefix `node-bullmq`; DB0 і історична result DB1 залишаються відокремленими. Результат демо також зберігається в PostgreSQL.

Приклад задачі детермінований і допускає повторне виконання. Між збереженням job і публікацією повідомлення немає transactional outbox: при аварії процесу в цей момент задача може залишитися queued. Для платежів та іншої критичної доставки додай outbox і відповідну ідемпотентність до прикладної логіки. BullMQ зберігає чергу й результати в Redis та підтримує повтори й відновлення stalled jobs; подробиці обмежень і повторів — у [контракті черги](docs/backend-variants.md).

Backup перед релізом зберігається на тому самому VPS; автоматичного offsite backup і ротації немає. Для важливих даних налаштуй щоденний backup і копію в окреме сховище. Старі образи, релізи і backup навмисно зберігаються для відкату; контролюй місце на диску. Secrets не повинні потрапляти в логи або git; `.env.example` призначений лише для локальної розробки/CI.

Офіційні довідки: [Vite](https://vite.dev/guide/), [Caddy SPA та API proxy](https://caddyserver.com/docs/caddyfile/patterns#single-page-apps-spas), [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Docker Engine на Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https/), [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).


## Лендинг та продуктова аналітика

[Налаштування Umami, маркетингові події, публічні домени й резервні копії](docs/analytics.md). Перший локальний вхід Umami — `admin` / `umami`; змініть пароль до публічного відкриття. Реєстрації в поточному MVP ще немає: `signup_completed` передбачено в SDK лише для підтвердженого успішного створення акаунта, а не для кліку на CTA.

Для локального лендингу поза Docker: `cd apps/landing`, `npm ci`, `npm run dev`. Публічна конфігурація читається з кореневого `.env`; аналітика лишається вимкненою до встановлення дійсного URL скрипта й UUID сайту. Після зміни `PUBLIC_*` production-образи frontend/landing потрібно перебудувати. Для GitHub Actions ці значення задаються в Repository Variables, а не читаються із серверного `.env`.
