# Лендинг, застосунок та Umami

`apps/landing` — статичний TypeScript/Vite лендинг; `apps/frontend` — React-застосунок;
`apps/api` — наявний Python API та Celery worker. `packages/analytics` — спільний браузерний
SDK без окремого сервера. Umami 3.4.1 і `umami-db` PostgreSQL 17.11 входять до Compose.
Аналітика не є залежністю API/readiness і не повинна блокувати роботу лендингу або застосунку.

## Локальні адреси

| Сервіс | Development | Production на loopback |
| --- | --- | --- |
| Застосунок | `http://localhost:5173` | `http://localhost:18001` |
| Лендинг | `http://localhost:5174` | `http://localhost:18002` |
| Umami | `http://localhost:3001` | `http://localhost:18003` |
| API | `http://localhost:8000` | `http://localhost:18000` |

Порти змінюються через `*_LOCAL_PORT` / `*_PORT`. База `umami-db` не має host-порту;
її облікові дані та volume відокремлені від бази застосунку. Umami використовує власного
користувача образу, має записувану файлову систему для штатного старту й міграцій та
перевірку `/api/heartbeat`; ця перевірка не підміняє окрему PostgreSQL readiness.

## Перший запуск і підключення

1. Підніміть dev-стек за кореневим README. Відкрийте локальний Umami.
2. Перший вхід офіційного образу — **`admin` / `umami`**. Змініть пароль у налаштуваннях
   акаунта до будь-якого публічного відкриття dashboard. Не існує налаштованої тут
   змінної середовища, яка автоматично встановлює пароль адміністратора.
3. Створіть website для свого продукту. Скопіюйте його справжній UUID та URL `script.js`.
   Лендинг і застосунок повинні використовувати один і той самий website ID, якщо ви
   хочете бачити їх в одному наборі звітів.
4. Встановіть публічні значення в кореневому `.env`:

   ```dotenv
   PUBLIC_APP_URL=http://localhost:5173
   PUBLIC_UMAMI_SCRIPT_URL=http://localhost:3001/script.js
   PUBLIC_UMAMI_WEBSITE_ID=<UUID створеного website>
   PUBLIC_UMAMI_DOMAINS=localhost
   ```

   `PUBLIC_UMAMI_DOMAINS` містить дозволені hostname без портів, через кому. Для production
   це можуть бути `eldhall.com,app.eldhall.com`. Порожній/некоректний URL чи UUID залишає
   tracking вимкненим. Перезапустіть dev-сервери після зміни env; production-образи потрібно
   перебудувати. Жодних API-токенів, паролів або секретів у `PUBLIC_*` / `VITE_*`.
5. Пройдіть шлях лендинг → CTA → застосунок і перевірте реальні події у Umami. Відмова
   завантаження скрипта/блокування аналітики не повинна блокувати навігацію чи UI.

Для CI образів браузерні `PUBLIC_*` передаються як Docker build arguments. GitHub Actions
читає їх із Repository Variables, а не із серверного `.env`; `PUBLIC_APP_URL` для деплою
потрібно задати явно. Для приватного доступу без домену можна явно використати
`http://localhost:18001`; для публічного — реальну HTTPS-адресу застосунку. Після зміни
цих змінних потрібен новий frontend/landing build.

## Події та межі атрибуції

| Подія | Коли вона правдива |
| --- | --- |
| `landing_viewed` | Лендинг відкрито з увімкненою валідною аналітикою |
| `landing_cta_clicked` | Реальний перехід із CTA; місце CTA зберігається окремою властивістю |
| `app_opened` | Застосунок відкрито |
| `signup_completed` | Лише підтверджене успішне створення акаунта |

Реєстрації в поточному UI ще немає. Наявний helper `trackSignupCompleted` викликається
майбутнім auth-кодом після підтвердження успіху, а не під час кліку чи відправлення форми.
Не передавайте email, паролі, access tokens або registration ID як event properties.
Контракт, дедуплікація й актуальні exports: [SDK](../packages/analytics/README.md).

SDK переносить тільки `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
через справжній URL CTA та зберігає контекст першого залучення в поточній сесії. URL події
санітизується; довільні query/hash-параметри не пересилаються. Контекст UTM зберігається і
для подій після зміни SPA-маршруту. Це дозволяє порівнювати кампанії та конверсійні події.
Один website ID і UTM relay **не гарантують** злиття анонімних сесій різних origin або
повної наскрізної user-level funnel-атрибуції. Не трактуйте клік як реєстрацію і не
обіцяйте детерміновану ідентичність користувача між доменами без окремого рішення.

## Секрети й існуючі середовища

`scripts/init-env.py` генерує окремі випадкові `UMAMI_POSTGRES_PASSWORD` та `UMAMI_APP_SECRET`.
База називається `umami` й використовує окремого користувача `umami`. Генерований hex-пароль
безпечний для DATABASE_URL; для ручного налаштування використовуйте URL-safe значення.
Скрипт не перезаписує існуючі `.env`.

Оновлюючи вже запущений проєкт, додайте лише нові Umami-ключі й порти до наявного `.env`
через приватний редактор або менеджер секретів. Не підміняйте старі credentials PostgreSQL,
Redis, RabbitMQ або `API_TOKEN` новим згенерованим файлом. На volume з уже ініціалізованою
базою зміна env-пароля сама по собі не змінює пароль користувача PostgreSQL.

## Публічні домени

Наявний `DOMAIN` залишається адресою застосунку. Звичайний `infra/compose.caddy.yaml`
і marker `.use-caddy` зберігають попередню поведінку одного app-host.

Додатковий `infra/compose.public-sites.yaml` разом з `infra/Caddyfile.sites` підтримує
три окремі host без підшляхів:

```dotenv
DOMAIN=app.eldhall.com
LANDING_DOMAIN=eldhall.com
UMAMI_DOMAIN=analytics.eldhall.com
ACME_EMAIL=ops@example.com
```

Після налаштування DNS, HTTPS, production-секретів і пароля Umami marker
`/opt/apps/<project>/.use-public-sites` вмикає обидва proxy-overlay під час наступного
деплою. Оберіть три різні hostname. Портам 80/443 потрібен один власник; для кількох
проєктів використовуйте зовнішній proxy. Налаштування DNS, деплой і публікація не
виконуються автоматично від створення цих файлів.

Офіційний Umami образ має build-time `BASE_PATH`; не переписуйте його під `/analytics`
лише reverse proxy. На окремому host `/script.js`, dashboard та `/api/*` зберігають штатні
шляхи. За потреби закрийте доступ до dashboard зовнішнім proxy окремо від collector;
browser tracking не повинен отримати Basic Auth challenge замість скрипта/API.

## Релізи, відкат і резервні копії

API/frontend/landing передаються як три образи одного Git SHA. `landing-image.ref`
перевіряється так само, як frontend; старі релізи без landing залишаються підтриманими.
Registry-образ Umami запускається окремо від `--pull never` локальних application images.

Симлінк `<deploy-root>/analytics-current` зберігає реліз із поточною конфігурацією Umami.
Звичайний відкат застосунку не перезапускає стару Umami-версію, не видаляє її volume й
не забирає analytics-reference. Тому `scripts/backup.sh` навіть після відкату app на
старий реліз створює окремі дампи app DB і Umami DB та друкує обидва шляхи. Перед відкатом збережіть абсолютний шлях до сучасного backup-скрипта (див. README): старий скрипт через змінений `current` не знає про аналітику. Перед наступним
деплоєм також зберігаються окремі копії обох баз.

Несподівана зміна Umami або analytics PostgreSQL image tag у звичайному app-деплої блокується до мутацій. Оновлення
Umami робіть окремою запланованою операцією: резервна копія analytics DB, перевірка офіційних
міграцій і сумісності версій, контрольований запуск нової analytics-конфігурації та health/
ingestion перевірка, потім оновлення `analytics-current`. Відновлення analytics DB із дампу
є окремою явною операцією; app rollback не відновлює і не понижує її схему.

Офіційні джерела: [Docker deployment](https://docs.umami.is/docs/install#installing-with-docker),
[перший вхід](https://docs.umami.is/docs/login), [website setup](https://docs.umami.is/docs/add-a-website),
[Tracker configuration](https://docs.umami.is/docs/tracker-configuration),
[Tracking events](https://docs.umami.is/docs/tracker-functions).
