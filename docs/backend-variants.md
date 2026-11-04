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

## BullMQ на наявному Redis

Node API та worker використовують BullMQ і той самий Redis-сервіс. Додаткового
брокера в поточному Compose немає; readiness перевіряє рівно PostgreSQL та Redis.
Worker має окремий healthcheck за heartbeat `${BULLMQ_PREFIX}:workers:<hostname>`
у виділеній BullMQ DB (типово DB2).

| Налаштування | Типове значення | Призначення |
| --- | --- | --- |
| `BULLMQ_DB` | `2` | Виділена logical DB; дозволено 2–15 |
| `BULLMQ_PREFIX` | `node-bullmq` | Простір ключів черги й worker |
| `BULLMQ_QUEUE` | `jobs-transform-v1` | Назва BullMQ-черги |
| `WORKER_CONCURRENCY` | `2` | Паралельні обробники worker |
| `BULLMQ_ATTEMPTS` | `4` | Перша спроба та до трьох повторів |
| `BULLMQ_BACKOFF_MS` | `1000` | Початкова затримка exponential backoff |
| `BULLMQ_RETENTION_COUNT` | `1000` | Ліміт збережених completed/failed jobs |
| `BULLMQ_COMPLETED_RETENTION_SECONDS` | `3600` | Вік збережених completed jobs |
| `BULLMQ_FAILED_RETENTION_SECONDS` | `86400` | Вік збережених failed jobs |

BullMQ зберігає власний стан виконання та `returnvalue` у своїй DB; окремої
самописної result-mirror у DB1 немає. PostgreSQL залишається джерелом job-відповідей
API. Retention BullMQ обмежує Redis-історію; SQL rows від цього не видаляються.
DB0 і історична result DB1 ізольовані від BullMQ.

Worker використовує reconnect і механізми повторів BullMQ. Producer не буферизує
HTTP-подання під час втрати Redis; наступний запит підключається заново після відновлення.
Якщо terminal failed state не записався в SQL через недоступність PostgreSQL, наступний
`GET /api/v1/jobs/{id}` може узгодити його зі збереженим failed job у BullMQ. Цей механізм
обмежений наявністю failed metadata: після її очищення за retention він не відновить
пропущений terminal SQL-статус. Збережені SQL-результати залишаються джерелом API-відповіді.

Redis налаштовано з AOF, `appendfsync everysec` та `maxmemory-policy noeviction` за
[production guide BullMQ](https://docs.bullmq.io/guide/going-to-production).
Після аварійної втрати Redis можливе зникнення останніх ще не синхронізованих записів;
ця конфігурація не є гарантією нульової втрати. Не вмикай eviction для queue keys.

BullMQ керує повторами й відновленням stalled jobs. Обробка може повторитися, тому
прикладні дії мають бути ідемпотентними. Між SQL commit job і додаванням у BullMQ немає
transactional outbox: аварія в цей проміжок може залишити SQL job queued без елемента
черги. Збережені SQL rows самі по собі не відновлюють втрачену Redis-чергу. Критичні
фічі потребують явного outbox та recovery-процесу; smoke перевіряє звичайний шлях.

## Перехід на існуючу БД

1. Припини прийом нових задач попереднім API. Дочекайся завершення queued/running jobs
   та спорожнення його черги; перевір реальні job-стани й стан черги, а не тільки readiness.
2. Збережи резервну копію. Зупини попередній Compose-стек зі збереженням volumes.
   Не виконуй `down --volumes`. Для Python/Celery або старого Node/AMQP спочатку заверши
   їхню роботу: BullMQ не читає їхніх повідомлень і не переносить їх автоматично.
3. Вибери повну гілку, збережи ідентичність і credentials існуючої БД. Перебудуй
   узгоджені образи API/frontend/landing та запусти залежності й міграцію за README.
4. Якщо міграція відхилила схему, зупини перехід та узгодь сумісність. За успіху запусти
   API й worker і виконай Node smoke через реальний frontend proxy. Старі RabbitMQ
   volumes та дані залиш збереженими; видалення сервісу з поточного Compose їх не видаляє.
   Збережи приватні credentials старого стека для використання архівних Compose-файлів.

Поточний `deploy.sh` автоматизує перехід архівного AMQP-релізу на BullMQ під deployment lock: зупиняє старий API, до 120 секунд чекає нуля SQL `queued/running` і RabbitMQ ready/unacked, зупиняє старий worker та повторно перевіряє відсутність роботи й consumers. Лише після цього бере backup і запускає міграцію. Недоступні лічильники, timeout або залишкова робота переривають deploy й відновлюють старий API/worker через rollback; broker і volumes зберігаються. Одноразовий діагностичний нуль без зупинки ingress не є дозволом на cutover. Цей автоматичний drain стосується AMQP → BullMQ, а не зворотного переходу.

Для повернення на Python також спочатку заверши задачі Node й зупини його стек.
Release/rollback scripts **цієї Node-гілки** перевіряють HTTP-працездатність і
вибирають runtime та залежності цільового релізу, включно з історичними Python/AMQP.
RabbitMQ запускається лише за його наявності в архівному Compose. Скрипти на Python
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
