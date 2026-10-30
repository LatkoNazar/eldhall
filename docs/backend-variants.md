# Python main та Node.js-варіант

`main` зберігає Python/FastAPI/Celery. `codex/node-backend` містить альтернативні
Node.js/TypeScript API й worker, їхні Docker/Compose entrypoints, npm lockfile,
міграції, CI й smoke. Для вибору варіанта використовуй повну гілку; для перенесення
в інший репозиторій потрібен увесь diff варіанта разом із конфігурацією та скриптами.

У звичайному clone зі збереженими локальними змінами:

```bash
git switch main
# Або:
git switch codex/node-backend
```

Якщо потрібна гілка вже відкрита в іншому Git worktree, працюй у тому worktree.
Кожна директорія має власні npm dependencies, приватний `.env`, Docker project name,
теги образів та host-порти. Не запускай два варіанти над одним production-стеком.

## API та збережені дані

Node зберігає маршрути `/health/live`, `/health/ready`, `POST /api/v1/jobs`,
`GET /api/v1/jobs/{id}`, Bearer `API_TOKEN` і основну структуру job-відповідей з
ідентифікатором `id`.

Перевірена функціональна сумісність охоплює ці канонічні job/health-маршрути та
перевірені випадки автентифікації й валідації body. Node серіалізує HTTP timestamps
через `Date.toISOString()` із мілісекундною точністю; під час прийняття сумісної БД
мікросекунди наявних записів у PostgreSQL зберігаються. Fastify та FastAPI можуть по-різному обробляти
непідтримувані HTTP-методи й адреси з trailing slash; деталі JSON-помилок валідації
також відрізняються.

SQL runner створює або перевіряє схему ревізії `0001_jobs`, включно з колонками,
типами, defaults та constraints, і зберігає наявні jobs. У сумісній Python-базі він
перевіряє `alembic_version`; невідому ревізію, відсутню таблицю або дрейф схеми
відхиляє. Це обмежений контракт поточної starter-схеми. Майбутні зміни моделей
потребують узгоджених міграцій і окремих перевірок переходу в обидва боки.

## Власна черга Node

Node використовує RabbitMQ queue `jobs.transform.node.v1` та JSON envelope
`{ "version": 1, "jobId": "<UUID>" }`. Черга durable, повідомлення persistent,
publisher чекає підтвердження брокера. Worker працює з manual ACK після SQL-результату
та запису результату в Redis. `WORKER_CONCURRENCY` задає prefetch, типово `2`;
`CELERY_CONCURRENCY` приймається лише як сумісна назва налаштування, якщо нова не задана.

Для тимчасових помилок worker робить до трьох повторних публікацій із backoff і
лічильником `x-attempt`. Попереднє повідомлення підтверджується після підтвердженого
replacement. Некоректний envelope, відсутній job або непідтримувана операція отримує
NACK без requeue. Після вичерпання повторів незавершений job позначається failed,
повідомлення також відхиляється без requeue. Окремий dead-letter storage не налаштовано.

Redis DB0 містить `node-worker:<hostname>` heartbeat, DB1 — `node-task:<id>` result.
Node не читає й не перезаписує Celery result keys. Durable delivery не усуває проміжок
між SQL commit job і публікацією: transactional outbox тут ще немає. Після аварії в цей
проміжок job може залишитись queued. Критичні фічі потребують явного outbox та
ідемпотентності; успішний smoke перевіряє звичайний шлях виконання.

## Перехід на існуючу БД

1. Припини прийом нових задач попереднім API. Дочекайся завершення queued/running jobs
   та спорожнення його черги; перевір реальні job-стани й broker, а не тільки readiness.
2. Збережи резервну копію. Зупини попередній Compose-стек зі збереженням volumes.
   Не виконуй `down --volumes`; не підміняй запущений Celery worker Node-процесом.
3. Вибери повну гілку, збережи ідентичність і credentials існуючої БД. Перебудуй
   узгоджені образи API/frontend/landing та запусти залежності й міграцію за README.
4. Якщо міграція відхилила схему, зупини перехід та узгодь сумісність. За успіху запусти
   API й worker і виконай Node smoke через реальний frontend proxy.

Для повернення на Python також спочатку заверши задачі Node й зупини його стек.
Release/rollback scripts **цієї Node-гілки** перевіряють HTTP-працездатність і
вибирають runtime цільового релізу, включно з історичним Python. Скрипти на Python
`main` залишаються Python-only: їхнє автоматичне відновлення після невдалого деплою
не підтримує Node-реліз як попередній runtime. Визначення runtime також не виконує
queue-drain або перетворення повідомлень. Перехід між backend-варіантами плануй як
завершення задач, зупинку старого стека та перебудову обраного повного варіанта.

## Операційні інструменти

API/worker image містить Node runtime. Standalone `scripts/frontend-smoke.mjs`,
`scripts/landing-smoke.mjs` та `apps/api/scripts/smoke.mjs` виконуються через
`api node --input-type=module -` зі stdin. Для історичних Python-релізів release scripts
з Node-гілки розпізнають `apps/api/scripts/smoke.py` та старіший
`apps/backend/scripts/smoke.py` й обирають Python усередині відповідного історичного image.

Хостові `init-env.py`, JSON-parsing deployment helpers та utility tests продовжують
використовувати Python 3.10+. Ця залежність не додається в Node API image. Umami і його
окрема база/backup/`analytics-current` мають той самий незалежний життєвий цикл, що в
[спільній foundation](analytics.md).
