# Додавання фіч через агентів і Git worktrees

Це інструкція для головного агента-координатора в поточному чаті.
Застосовуй її, коли користувач доручає реалізацію фіч за цим workflow.
Вона описує роботу доступними Git та агентними інструментами; окремого автоматичного runner тут немає.

## 1. Зафіксуй вихідний стан

Перед редагуванням, а також після відновлення сесії перевір:

```powershell
Get-Location
git status --short --branch
git worktree list
git branch --show-current
git rev-parse HEAD
```

Прочитай застосовні `AGENTS.md`, README та наявні `.omc/state/` і `.omc/handoffs/`.
Збережи абсолютний шлях репозиторію, поточну гілку та її SHA як базу цього пакета фіч.
Створюй фічі саме від цього SHA, а не автоматично від `main` чи `origin/main`.
За detached HEAD спочатку визнач робочу гілку. За сторонніх незакомічених змін не роби reset, stash або commit без узгодження; спочатку відокрем їх від задачі.

Поточна звичайна робоча гілка стає інтеграційною: результати повертаються в неї.
Якщо це `main` або інша захищена гілка, перед реалізацією створи від її поточного SHA гілку `integration/<пакет>-<унікальний-id>`.
Визнач ціль PR: `main` за замовчуванням або погоджена батьківська гілка. Не перемикай базу непомітно.

## 2. Розділи роботу й створи worktrees

Розбий запит на завершені фічі з критеріями приймання, межами файлів і залежностями.
Незалежні фічі передавай окремим executor-агентам паралельно.
Для спільних контрактів, lockfile, реєстрації роутерів, Compose або міграцій признач одного власника чи послідовність виконання.
Залежну фічу запускай після злиття її передумови; явно зафіксуй новий базовий SHA для неї.

Приклад PowerShell з кореня репозиторію; значення назв обери під задачу:

```powershell
$repoPath = (git rev-parse --show-toplevel).Trim()
$startBranch = ((git branch --show-current) -join '').Trim()
$baseSha = (git rev-parse HEAD).Trim()
if (-not $startBranch) { throw 'Спочатку обери робочу гілку замість detached HEAD.' }
$protectedBranches = @('main', 'master') # Доповни іншими захищеними гілками репозиторію.
if ($startBranch -in $protectedBranches) {
    $batchBranch = "integration/features-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    git switch -c $batchBranch $baseSha
    if ($LASTEXITCODE -ne 0) { throw 'Інтеграційну гілку не створено.' }
}
$integrationBranch = ((git branch --show-current) -join '').Trim()
$featureId = "jobs-export-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$featureBranch = "feat/$featureId"
$repoName = Split-Path -Leaf $repoPath
$worktreePath = Join-Path (Split-Path -Parent $repoPath) "$repoName-wt-$featureId"
git worktree add -b $featureBranch $worktreePath $baseSha
if ($LASTEXITCODE -ne 0) { throw 'Worktree не створено; агента не запускай.' }
```

Перевір унікальність гілки та відсутність цільового каталогу перед створенням.
Після кожної Git-команди перевір код завершення; за помилки не виконуй залежні кроки.
Кожна фіча має власну гілку й абсолютний шлях worktree поза каталогом репозиторію.
Передай цей шлях агенту явно: запуск subagent сам собою не ізолює файлову систему.
В усіх його командах задай цей `workdir`; заборони редагувати інтеграційний каталог та чужі worktrees.
Одна директорія має одного автора. Не запускай двох авторів у тому самому worktree.

## 3. Завдання виконавцю

Передай агенту: мету, критерії приймання, дозволену область, залежності, базовий SHA, гілку, абсолютний workdir і потрібні перевірки.
Python backend розташований у `apps/api`, React/TypeScript застосунок — у `apps/frontend`, TypeScript/Vite лендинг — у `apps/landing`. Спільний браузерний SDK — у `packages/analytics`; `.env`, Compose, `infra/` та серверні скрипти спільні в корені. Обидва вебзастосунки використовують npm та власні `package-lock.json`; признач одного автора для змін кожного lockfile й одного для спільного SDK. Окремий Node.js API-варіант не змінює Python foundation: його розробляй в окремій гілці від перевіреної спільної бази.
Нові модулі додавай у `apps/api/src/app/modules/`, дотримуючись меж модульного моноліту з README.

Git не переносить ігноровані `.env`, `.venv` та локальні артефакти у worktree.
Створи там власний `.env` з `.env.example` або явно дозволеної конфігурації розробки; production-секрети не копіюй.
Встанови залежності worktree окремо. З його кореня:

```powershell
uv --directory apps/api sync --frozen
uv --directory apps/api run ruff check .
uv --directory apps/api run ruff format --check .
uv --directory apps/api run pytest
```

Для frontend з директорії `apps/frontend` виконай `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` і `npm run build`.
Frontend-набір також перевіряє `packages/analytics`; для landing з `apps/landing` виконай `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`. Обидва Dockerfile вебзастосунків збираються з кореневого context, щоб включити спільний пакет.

У кожному worktree `PROJECT_NAME` задає локальну ідентичність застосунку; за замовчуванням шаблон використовує `starter`.
За паралельного запуску Compose виділи кожному worktree унікальний `PROJECT_NAME` або локальний override `COMPOSE_PROJECT_NAME`, а також власні `APP_IMAGE`, `FRONTEND_IMAGE` і host-порти:
`API_LOCAL_PORT`, `FRONTEND_LOCAL_PORT`, `POSTGRES_LOCAL_PORT`, `REDIS_LOCAL_PORT`, `RABBITMQ_LOCAL_PORT`, `RABBITMQ_MANAGEMENT_LOCAL_PORT`; для production-подібного запуску — `APP_PORT` і `FRONTEND_PORT`.
Самого окремого project name недостатньо: порти та тег образу також можуть конфліктувати.
`COMPOSE_PROJECT_NAME` використовуй для локальної ізоляції; production-ім'я визначає `PROJECT_NAME` і має збігатися з однойменною GitHub Variable.
Використовуй ці значення послідовно для build/up/run/exec/down; дані мають бути локальними для цього проєкту.
Для Python поза контейнерами врахуй localhost і призначені порти; у контейнерах залиш внутрішні адреси сервісів.

Виконавець реалізує фічу, перевіряє поведінку та комітить лише свої зміни у власній гілці.
Він не зливає її самостійно в інтеграційну гілку або `main`.
Повертає координатору: гілку/workdir, SHA комітів, змінені файли, результати команд, виконані критерії приймання та ризики.
Пропущені перевірки вказує явно. Зелений unit-набір сам собою не доводить роботу нової фічі.

## 4. Інтегруй послідовно

Координатор перевіряє diff, SHA, чистоту worktree та докази виконання критеріїв.
У своєму початковому каталозі повторно перевіряє `git status --short --branch` і назву інтеграційної гілки.
Зливай готові гілки по одній у порядку залежностей:

```powershell
git merge --no-ff $featureBranch
```

Якщо merge зупинився, виріши конфлікти й перевір сумісність поведінки; не обирай автоматично ours/theirs для всіх файлів.
Врахуй семантичні конфлікти навіть за чистого merge: API-контракти, імпорти, task registration, залежності та міграції.
Виконавці зупиняють редагування перед передачею гілки на merge.
Подальші виправлення роби в інтеграційній гілці одним призначеним автором або в новій repair-гілці від її актуального SHA.

Після злиття пакета запусти Ruff, форматування й повний Python unit-набір наведеними вище командами, а також lint, typecheck, тести й production build frontend та перевірки landing. Для змін deployment також запусти `python -m unittest discover -s scripts/tests -p 'test_*.py' -v` і `bash scripts/tests/test-release.sh`.
Перевір `uv --directory apps/api run alembic heads`: має залишитися один узгоджений head; за розгалуження створи й перевір merge-міграцію.
На ізольованому dev-стеку перебудуй образ, застосуй міграції до чистої БД і перевір оновлення попередньої схеми, якщо змінювалася схема.
Запусти API й worker за README та виконай наявний smoke:

```powershell
Get-Content -Raw apps/api/scripts/smoke.py | docker compose -f compose.yaml -f compose.dev.yaml exec -T api python -
```

Smoke доводить наявний шлях API → RabbitMQ → Celery → PostgreSQL та readiness залежностей. Після змін frontend/proxy додатково перевір цей шлях через frontend, використовуючи `SMOKE_BASE_URL=http://frontend:8080` і `SMOKE_HOST=localhost` у trusted API-контейнері для production-образу, а також `/`, SPA deep link, відсутній `/assets/*` і відсутній `/api/*`. Vite dev proxy перевіряй окремо від production Caddy. Не передавай `API_TOKEN` у browser bundle або `VITE_*`.
Окремо перевір нові API/фонові сценарії, їхні помилки й права доступу; додай відповідні перевірки за потреби.
Не позначай блоковані або невиконані перевірки як успішні.

Для змін лендингу перевір `/landing-health`, справжні 404 та зібрані assets через `scripts/landing-smoke.py`; браузером перевір реальний перехід у застосунок і перенесення дозволених UTM. Для аналітики користуйся [контрактом і налаштуванням](docs/analytics.md). `scripts/analytics-smoke.mjs` з явним `UMAMI_SMOKE_ALLOW_DEFAULT_CREDENTIALS=1` призначений лише для ізольованого CI/QA Umami з тестовим website; ніколи не використовуй default login на production. Наявні події не доводять реалізацію реєстрації. Повний render відео не входить до CI application: `demos/` має власний workflow і QA, а MP4/джерела передаються команді через Git LFS.

## 5. Незалежне рев’ю та PR

Запусти іншого code-reviewer/verifier-агента на весь diff інтеграційної гілки відносно цілі PR та результати перевірок.
Він перевіряє критерії приймання, межі модулів, регресії, міграції й відсутність незавершених заглушок.
Автор коду не затверджує власний результат. Виправ зауваження, повтори зачеплені перевірки й отримай окреме повторне рев’ю актуального SHA.
Після успішної перевірки запуш інтеграційну гілку й створи PR, якщо це входить у доручений користувачем workflow.
PR має містити проблему, отриману поведінку, результати перевірок і суттєві обмеження. Дочекайся CI та усунь його помилки.
Merge PR і production-деплой виконуй відповідно до дорученого workflow та вже наданих у сесії повноважень.

## 6. Прибери завершені worktrees

Спочатку дочекайся зупинки агентів і зупини лише їхні Compose-проєкти без видалення volumes.
Видаляй feature-worktree тільки коли він чистий, потрібні коміти досяжні з інтеграційної гілки, а ця гілка запушена.
Перевір також ігноровані локальні файли: збережи потрібні артефакти до видалення каталогу.
Звір абсолютний шлях з `git worktree list`. Після перевірки чистоти й запушеного стану:

```powershell
git merge-base --is-ancestor $featureBranch $integrationBranch
if ($LASTEXITCODE -ne 0) { throw 'Коміти фічі не підтверджені в інтеграційній гілці.' }
git worktree remove $worktreePath
if ($LASTEXITCODE -ne 0) { throw 'Worktree залишено; перевір причину відмови Git.' }
```

Видалення виконуй без `--force`.
Якщо Git відмовляє, з’ясуй причину; не обходь захист через рекурсивне видалення чи `prune`.
Локальні feature-гілки залиш до merge PR. Після нього перевір ancestry їхніх комітів у цільовій гілці й видаляй через `git branch -d`.
За squash/rebase merge коміти можуть не бути її предками: тоді збережи гілки, не застосовуй `-D` автоматично.
Інтеграційну гілку й незлиті результати не видаляй. Повідом користувачу PR, перевірений SHA, CI та що залишено локально.

Довідка: [офіційна документація Git worktree](https://git-scm.com/docs/git-worktree).
