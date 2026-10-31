# D13 — Open-source пакування, документація та супровід

**Пріоритет:** P0 для публічного релізу; contributor ecosystem — P1.  
**Передумови:** завершений головний `TODO.md`. D13-01/02 виконуються рано, до publication D01; решта документації завершується на перевірених D01/D02 install artifacts і D04 integration reference.
**База огляду:** `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01.  
**Результат:** сторонній розробник розуміє призначення Eldhall, встановлює його й може виправити проблему без пояснень автора в чаті.

## 1. Підтверджений стан

У дереві репозиторію на baseline немає кореневого `LICENSE`; [STATUS.md](../docs/STATUS.md) каже, що ліцензію не обрано. [README.md](../README.md) починається актуальним Support Copilot, а далі містить великий Competition Starter guide із landing/Umami і варіантами backend.

[CLAUDE.md](../CLAUDE.md) досі має хакатонний deadline, WS1 ownership та branch flow, посилання на відсутній `scripts/llm-spike.ts` і застаріле обмеження щодо нової інфраструктури. Є кілька документів про implementation/architecture/target roadmap, а в [docs/SECURITY.md](../docs/SECURITY.md) частина історичних оцінок не відповідає поточним деталям коду.

Це задача узгодження продукту й підтримки. Наявні тести, agent instructions і starter assets слід інвентаризувати, а не механічно видаляти.

## 2. D13-01 — Визначити публічний product contract

- [ ] Обрати послідовну назву продукту в README, API metadata, images, UI та package metadata; вихідна пропозиція — Eldhall.
- [ ] Перший абзац пояснює: self-hosted support-agent service із контрольованими бізнесовими діями, API та optional operator UI.
- [ ] Описати три способи використання: headless API, bundled UI, інтеграція власного backend/channel.
- [ ] Показати базові залежності: PostgreSQL, Redis, API/worker; UI та MCP sidecar за потреби.
- [ ] Вказати, які частини є демонстраційними: зокрема simulated payments.
- [ ] Опублікувати перевірену support matrix: release, CPU architecture, deployment recipe, provider/runtime, config/schema compatibility.
- [ ] Розділити implemented, experimental і planned capabilities; roadmap checkbox не є доказом підтримки.
- [ ] Приклади Docker Hub namespace, доменів і tokens до їх створення позначати placeholders.

## 3. D13-02 — Ліцензія, attribution і право розповсюдження

Вибір ліцензії належить власникам коду. Підготовка задач не змінює ліцензію автоматично.

- [ ] Зафіксувати owner decision щодо ліцензії вихідного коду, docs і example assets.
- [ ] Додати кореневий `LICENSE` та відповідний SPDX identifier у package/image metadata.
- [ ] Звірити внески команди й залежності, що потрапляють у source distribution та container images.
- [ ] Згенерувати dependency/license inventory; перевірити bundled runtime, Python packages, fonts/media, demo assets і third-party examples.
- [ ] Додати required notices/attributions для фактично розповсюджуваних компонентів.
- [ ] Визначити contributor contribution policy; не впроваджувати CLA/DCO без чіткого рішення підтримувачів.
- [ ] Окремо перевірити, чи потрібні користувачу власні model/API credentials та які optional services не входять у поставку.
- [ ] Публічний release D01 не має випереджати невирішене питання прав на artifacts.

Довідки: [Open Source Definition](https://opensource.org/osd), [SPDX License List](https://spdx.org/licenses/). Наявність SPDX назви не замінює вибір ліцензії власником і перевірку складу конкретного релізу.

## 4. D13-03 — Одна зрозуміла документаційна структура

Цільовий entry point:

1. **Quickstart:** завантажити release bundle, init, pull, up, перевірити перший кейс.
2. **Integrate:** customer identity, create case, send message, receive event/result, operator handoff.
3. **Configure:** повний reference env/config, precedence, defaults, examples, secrets.
4. **Operate:** backup/restore, upgrade/rollback, scaling, health, diagnostics.
5. **Extend:** OpenAPI/MCP connector, permissions, provider/runtime adapter.
6. **Contribute:** локальний dev, module map, tests, migrations, PR expectations.

- [ ] Переписати README навколо supported product path із D02.
- [ ] Starter-specific instructions перенести в явно позначений historical/development guide.
- [ ] Документи target architecture і історичні security/status snapshots позначити датою та scope.
- [ ] Визначити один source of truth для API DTO/OpenAPI, configuration schema і release support matrix.
- [ ] Приклади команд перевіряти на чистому environment; помилки/очікуваний output описувати поруч.
- [ ] Окремі guides для bundled DB і external PostgreSQL; показати dedicated database/schema policy.
- [ ] Додати troubleshooting за симптомами: unhealthy worker, invalid config, migration mismatch, model unavailable, unknown action, stale source.
- [ ] Уточнити optional telemetry/analytics; data flows і enable/disable мають бути видимими.
- [ ] Технічні docs можуть бути англійською для OSS аудиторії, українські пояснення зберегти як локалізацію; обрати підтримувану primary language і process синхронізації.
- [ ] Cross-links мають працювати після видалення головного TODO; task файли посилаються на permanent docs, коли реалізація завершена.

## 5. D13-04 — Contributor workflow

- [ ] Оновити `CLAUDE.md`/`FEATURE_WORKFLOW.md` для чинних boundaries, команд і branch/review правил.
- [ ] Зафіксувати хто змінює shared contracts і як синхронізуються кілька людей/агентів; застарілі хакатонні заборони прибрати через звичайний review.
- [ ] Додати `CONTRIBUTING.md`: setup, coding style, adding module/connector, migrations, test commands, docs expectations.
- [ ] Додати issue templates для bug report, integration request і feature proposal.
- [ ] Bug template просить version/image digest, deployment mode, redacted doctor output, reproduction; secrets і приватні чати не потрібні.
- [ ] PR template пояснює проблему, behavior, compatibility/migration impact та meaningful validation.
- [ ] Owner map/CODEOWNERS охоплює auth/policy/execution, API contracts, migrations/release та docs.
- [ ] Dependency updates групувати за runtime/protocol/storage boundaries і перевіряти conformance, а не сліпо merge.
- [ ] Small docs/example change не повинен вимагати paid LLM credentials.
- [ ] Реальний smoke environment і базові fixtures доступні contributor без приватного сервера автора.

## 6. D13-05 — Repo hygiene і distributable artifacts

- [ ] Інвентаризувати demo videos, pitch binaries, LFS assets і build artifacts; визначити що потрібне source contributors, runtime image, docs site та release.
- [ ] Large demo media не повинні завантажуватися лише для встановлення Docker-продукту.
- [ ] Перевірити `.dockerignore`/build contexts на assets, local secrets, git metadata і tests, які не потрібні runtime.
- [ ] Визначити release assets: image digests, compose/env/config examples, OpenAPI spec, checksums, changelog, compatibility notes.
- [ ] Зберегти відтворювані source/build instructions для опублікованих image revisions.
- [ ] Відрізняти private development repo від публічного release surface; зміна visibility репозиторію є окремою дією owner.
- [ ] Додати автоматичну перевірку broken links і generated-doc drift.
- [ ] Root TODO після виконання видаляється за його критеріями; `todos/` лишається roadmap до завершення відповідних задач.

## 7. D13-06 — Release policy, support і повідомлення про проблеми

- [ ] Описати semver/support window і compatible upgrade paths разом із D01/D03.
- [ ] Changelog містить user-visible changes, deprecations, data migration та rollback limitations.
- [ ] Додати кореневий `SECURITY.md` із підтримуваними версіями й приватним каналом повідомлення; існуючий `docs/SECURITY.md` лишити датованим технічним review або оновити його статус.
- [ ] Визначити triage labels: bug, install, connector, runtime/provider, docs, security, regression.
- [ ] Додати відтворювані runbooks для інцидентів та регресій.
- [ ] Не вказувати гарантований SLA, поки немає процесу/ресурсів підтримки.
- [ ] Docker Hub README генерувати з перевіреної документації того самого release, а не підтримувати як окрему забуту копію.
- [ ] Публічні screenshots/відео мають відповідати released behavior і використовувати synthetic data.

## 8. D13-07 — Перевірити onboarding сторонніми розробниками

- [ ] Дати release bundle щонайменше двом людям, які не писали ядро.
- [ ] Одна встановлює на чистому host через Docker Hub, друга інтегрує власний маленький backend через SDK/API.
- [ ] Записати кроки, час до першої коректної відповіді, блокери, незрозумілі терміни й потребу в усній допомозі.
- [ ] Виміряний час показувати з умовами: download/network/model setup окремо. Мета «просто як звична інфраструктурна бібліотека» не означає вигаданий five-minute benchmark.
- [ ] Виправити документацію й setup errors, повторити ті самі сценарії.
- [ ] Перевірити upgrade і restore за інструкціями без автора поруч.
- [ ] Додати результати до release evidence D00.

## 9. File map і завершення

`README.md`, `CLAUDE.md`, `FEATURE_WORKFLOW.md`, нові `LICENSE`/`CONTRIBUTING.md`/`SECURITY.md`, `docs/` index, issue/PR templates, Docker Hub README generation та release assets.

**Definition of done:** owner license decision зафіксований; install/integration/operate docs узгоджені з release; commands перевірені; contributor не потребує private setup; два зовнішні walkthrough мають записані й усунені blockers.

Public marketplace, окремий community portal, complex docs framework та маркетинговий сайт не є передумовою якісної документації.

