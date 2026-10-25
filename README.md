# Основа для змагання

FastAPI, PostgreSQL, Redis, Celery та RabbitMQ в одному репозиторії. Модульний моноліт має спільний образ і базу; API та Celery запускаються окремими процесами з того самого коду. Docker Compose призначений для одного Linux VPS. CI перевіряє реальну фонову задачу до деплою.

Робота з фічами через головного агента та окремі worktrees: [інструкція](FEATURE_WORKFLOW.md).

## Локальний запуск

Потрібні Docker з Compose v2.24+ та Git. Python окремо потрібен лише для роботи поза контейнерами.

```powershell
Copy-Item .env.example .env
docker compose -f compose.yaml -f compose.dev.yaml build
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres redis rabbitmq
docker compose -f compose.yaml -f compose.dev.yaml run --rm migrate
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait api worker
```

API: http://localhost:8000/docs. RabbitMQ UI: http://localhost:15672, логін і пароль з `.env`. Порти БД, Redis і RabbitMQ у dev доступні тільки на localhost. API автоматично перечитує зміни `apps/backend/src/`; worker після змін перезапускай: `docker compose -f compose.yaml -f compose.dev.yaml restart worker`. Після зміни залежностей перебудуй образ.

```powershell
$headers = @{ Authorization = "Bearer development-token-not-for-production" }
$job = Invoke-RestMethod http://localhost:8000/api/v1/jobs -Method Post -Headers $headers -ContentType application/json -Body '{"text":"hello","operation":"uppercase"}'
Invoke-RestMethod "http://localhost:8000/api/v1/jobs/$($job.id)" -Headers $headers
Get-Content -Raw apps/backend/scripts/smoke.py | docker compose -f compose.yaml -f compose.dev.yaml exec -T api python -
```

`GET /health/live` перевіряє процес, `/health/ready` — PostgreSQL, Redis та RabbitMQ. Окремий Docker healthcheck worker перевіряє відповідь Celery; smoke також чекає виконання задачі. У production Swagger вимкнений, API задач захищено Bearer `API_TOKEN`. Не вбудовуй спільний API_TOKEN у публічний frontend: перед відкриттям застосунку для користувачів додай його власну автентифікацію.

## Структура та нові модулі

```text
apps/
  backend/
    src/app/
      main.py         # збирає застосунок і роутери
      core/           # конфіг, БД, Celery, спільна інфраструктура
      modules/
        system/       # health endpoints
        jobs/         # model, schemas, services, router, tasks
    migrations/       # спільний ланцюжок Alembic
    tests/
    scripts/smoke.py  # перевірка API та фонової задачі
    pyproject.toml
    uv.lock
    alembic.ini
    Dockerfile
infra/                # необов'язковий Caddy
scripts/              # deploy, rollback, backup, генерація env
.github/workflows/    # CI та деплой з main
compose*.yaml         # спільна інфраструктура всіх застосунків
.env.example          # спільна конфігурація середовища
```

Кожен застосунок має власні залежності, тести й Dockerfile. Майбутній JS frontend можна додати в `apps/frontend/` зі своїм `package.json` та lockfile; зараз створений тільки backend. Docker Compose, CI/CD і скрипти сервера залишаються спільними в корені репозиторію.

Для фічі створюй `apps/backend/src/app/modules/<feature>/` і підключай її router у `main.py`. Логіку тримай в services, HTTP у router, ORM у models, Celery-обгортки у tasks. Інші модулі викликають публічні сервіси, не їхні router. Зареєструй ORM-моделі у `apps/backend/migrations/env.py`, а task-модулі — у `core/celery_app.py`. Перевірки архітектурних меж не автоматизовані; дотримуйся цих правил у коді.

Команди Python запускай з директорії backend:

```powershell
cd apps/backend
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Для локального Python підстав у змінні середовища `POSTGRES_HOST`, `REDIS_HOST`, `RABBITMQ_HOST` значення `localhost`; credentials беруться зі спільного `.env` у корені репозиторію. Усі контейнери використовують внутрішні DNS-імена сервісів. З `apps/backend/` команда `uv run alembic revision --autogenerate -m "feature"` створює міграцію, `uv run alembic upgrade head` застосовує її. Після створення міграції локально включи її у наступний Docker build. У production не запускай autogenerate: лише перевірені міграції з Git. Команди Docker Compose та серверні скрипти запускай з кореня репозиторію.

## Перший серверний запуск

Спочатку визнач сервер, SSH-користувача, домен і наявний reverse proxy. Не запускай додатковий proxy на зайнятих 80/443.

1. На Ubuntu без Docker: скопіюй `scripts/bootstrap-ubuntu.sh` і запусти `sudo bash bootstrap-ubuntu.sh <deploy-user> /opt/comp-prep`. Скрипт використовує офіційний Docker apt repository, не змінює DNS і firewall. Перепідключи SSH після додавання користувача до групи docker. На інших Linux встанови Docker Engine та Compose за офіційною інструкцією.
2. Створи приватний production env: `python scripts/init-env.py --domain api.your-domain.com --email you@your-domain.com`. Файл `.env` створюється з випадковими секретами та не перезаписує наявний. Перенеси його на сервер як `/opt/comp-prep/.env` з правами `600`; у GitHub паролі БД передавати не потрібно. На Windows NTFS додатково обмеж доступ до локального файлу своїм користувачем.
3. Якщо є host Nginx/Caddy, направ піддомен на `http://127.0.0.1:18000` і налаштуй TLS на ньому. Якщо proxy теж у контейнері, його localhost відрізняється від host: підключи його до спільної Docker-мережі та налаштуй upstream окремо. Якщо 80/443 вільні, створи `/opt/comp-prep/.use-caddy`: deploy підніме наш Caddy. DNS A має вказувати на сервер; AAAA додавай лише за робочого IPv6. Дозволь вхідні 80/443 у мережевих правилах сервера.
4. Створи окремий SSH-ключ для GitHub Actions і додай його public key у `~/.ssh/authorized_keys` deploy-користувача. Приватний ключ зберігай тільки у GitHub Secret. Звір fingerprint сервера через довірений доступ; `DEPLOY_KNOWN_HOSTS` має містити відповідний запис `known_hosts`, а для нестандартного порту — `[host]:port`.
5. У Settings → Secrets and variables → Actions налаштуй значення нижче; увімкни `DEPLOY_ENABLED=true` після підготовки сервера. Push у `main` або ручний запуск workflow зробить перший реліз.

| Тип | Назва | Значення |
| --- | --- | --- |
| Variable | `DEPLOY_ENABLED` | `true`, щоб автоматично деплоїти main |
| Variable | `DEPLOY_HOST` | IP або DNS сервера |
| Variable | `DEPLOY_USER` | SSH-користувач з Docker-доступом |
| Variable | `DEPLOY_PORT` | за замовчуванням `22` |
| Variable | `DEPLOY_PATH` | за замовчуванням `/opt/comp-prep`; без пробілів |
| Variable | `PUBLIC_URL` | `https://api.your-domain.com`; перевірка HTTPS після деплою |
| Secret | `DEPLOY_SSH_KEY` | окремий приватний ключ для Actions |
| Secret | `DEPLOY_KNOWN_HOSTS` | перевірений SSH host key сервера |

CI запускає lint, форматування, unit tests, збирає образ, мігрує чисту БД і виконує задачу через справжню чергу. Деплой запускається лише після успішного CI для main та за ввімкненої змінної. Образ з тегом Git SHA передається через SSH як архів: серверу не потрібні GitHub registry credentials. Наразі CI збирає linux/amd64; для ARM VPS зміни platform у build та runner/перевірці відповідно.

## Релізи, відкат і дані

Сервер зберігає `.env` окремо від `releases/<sha>/`. Деплой серіалізовано через `flock`; спочатку перевіряються залежності, потім перед оновленням наявного релізу робиться `pg_dump`, застосовуються міграції, оновлюються API/worker і виконується smoke. Після успіху `current` вказує на реліз, `previous` — на попередній. Під час рестарту API можлива коротка перерва. Це один VPS, без гарантії високої доступності.

```bash
bash /opt/comp-prep/current/scripts/backup.sh /opt/comp-prep
bash /opt/comp-prep/current/scripts/rollback.sh /opt/comp-prep

# Команди керування поточним релізом
cd /opt/comp-prep/current
export APP_IMAGE="$(cat image.ref)"
docker compose --project-name comp-prep --env-file /opt/comp-prep/.env -f compose.yaml -f compose.prod.yaml ps
docker compose --project-name comp-prep --env-file /opt/comp-prep/.env -f compose.yaml -f compose.prod.yaml logs --tail 100 -f api worker
```

Відкат повертає образ застосунку, але не схему БД. Деплой автоматично пробує відновити попередні API/worker при помилці. Міграції повинні бути сумісні з попереднім кодом: додавання поля/таблиці окремо від видалення старого. Відновлення БД роби лише усвідомлено зі збереженої копії: воно замінює дані. Для перевірки архіву: `pg_restore --list <backup.dump>` у контейнері PostgreSQL.

PostgreSQL, RabbitMQ, Redis і Caddy мають постійні Docker volumes. Не виконуй `down --volumes` на сервері. Дані в `.env` застосовуються до користувачів PostgreSQL/RabbitMQ при першій ініціалізації: зміна пароля у файлі не змінить його у вже створеній БД. Redis використовує пароль і AOF; RabbitMQ — durable messages; Celery result backend — Redis DB1, cache — DB0. Результат демо також зберігається в PostgreSQL.

Приклад задачі детермінований і допускає повторне виконання. Між збереженням job і публікацією повідомлення немає transactional outbox: при аварії процесу в цей момент задача може залишитися queued. Для платежів та іншої критичної доставки додай outbox і відповідну ідемпотентність до прикладної логіки.

Backup перед релізом зберігається на тому самому VPS; автоматичного offsite backup і ротації немає. Для важливих даних налаштуй щоденний backup і копію в окреме сховище. Старі образи, релізи і backup навмисно зберігаються для відкату; контролюй місце на диску. Secrets не повинні потрапляти в логи або git; `.env.example` призначений лише для локальної розробки/CI.

Офіційні довідки: [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Docker Engine на Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https/), [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).
