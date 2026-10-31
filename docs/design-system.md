# Дизайн-система Eldhall Support

**Версія 0.2.0-proposal · 31 жовтня 2026 · handoff для командного рев’ю.**
Основа — шість PNG користувача; це специфікація майбутнього dashboard, а не реалізований UI.
Активний набір — шість нових світлих референсів нижче; він повністю замінює попередній набір.
Нормалізовані значення містить [design-system.tokens.css](design-system.tokens.css). Файл є довідником, не підключеним стилем застосунку.
Продуктові межі: [бізнес-модель](business-model.md), [архітектура](architecture-review.md), [інтеграції](integrations.md).

Зміст: [джерела](#references) · [основи](#foundations) · [layout](#layout) · [компоненти](#components)
· [екрани](#screens) · [агентні стани](#agent-states) · [контракти](#contracts) · [QA](#qa).

## 1. Обсяг і правила читання

Dashboard є опційним web-клієнтом API; чат-віджет незалежний, повний headless setup залишається доступним.
Візуальна наявність Settings, Team або Approve не створює backend-дозволу й не визначає тарифну комплектацію.
DeepSeek Harness — типовий runtime; UI показує продуктові події, доступні через API, а не внутрішній інтерфейс DSH.
Назва Eldhall, логотип, аватари та demo copy походять із референсів; production assets затверджуються окремо.

Позначення впевненості застосовуємо до всіх подальших чисел:

- **Спостережено:** елемент або композиція видимі в PNG.
- **Оцінено:** розмір/колір наближено визначено з растру; це не вихідний CSS чи Figma.
- **Запропоновано:** канонічне значення для реалізації, включно з доступністю й адаптивністю.

Фокус, hover, loading, errors, mobile, keyboard і reduced motion у PNG не показані; їх визначено як пропозицію.
Точну гарнітуру, ваги шрифту, shadow blur або бізнес-поведінку неможливо довести одним растровим кадром.

<a id="references"></a>
## 2. Реєстр референсів і походження

Копії PNG збережені без змін. ID відповідає порядку зображень користувача; SHA-256 ідентифікує конкретний файл.
Усі шість PNG мають розмір **1536×1024 px**. [Портативний manifest](design-system/references/manifest.json) містить також bytes і повні назви джерел.

| ID / екран | Локальна копія | Оригінальна назва |
| --- | --- | --- |
| R1 · AI actions | [01-ai-actions.png](design-system/references/01-ai-actions.png) | `AI_действия_возврат_дублированного_платежа_2.png` |
| R2 · Knowledge base | [02-knowledge-base.png](design-system/references/02-knowledge-base.png) | `База знаний для AI-поддержки-3.png` |
| R3 · Inbox | [03-inbox.png](design-system/references/03-inbox.png) | `ИИ-поддержка_ двойное списание-1.png` |
| R4 · Team | [04-team.png](design-system/references/04-team.png) | `Команда поддержки eldhall-5.png` |
| R5 · Analytics | [05-analytics.png](design-system/references/05-analytics.png) | `Панель аналитики поддержки eldhall-4.png` |
| R6 · Settings | [06-settings.png](design-system/references/06-settings.png) | `Настройки ИИ-помощника eldhall-6.png` |

| ID | SHA-256 |
| --- | --- |
| R1 | `870CA9F0CA9E6F6DF24B570CBF918AB9028FABE5A514A0F2C6B2242BA28227CB` |
| R2 | `5016A36CFBECA9A0CB816A4ED307DA5E56AC94C15B257A0C36E27504B6B68303` |
| R3 | `7E0BC128E8141A470ABDAF3893D479A6E8112A11A8FEDA2BE00EF1077A2D01AE` |
| R4 | `1E6BA0E736031E44A6312D60496E37FC6065B5D63E4B1A807AB06B41463C4271` |
| R5 | `C52582D9A90F6E4CE4197A83FFBA55C844AF32CC2BBCF408197FC7A421A98CD5` |
| R6 | `BD2644EAF5022FEEDE1A7D065D03D0A755786773681FDE5C87CF51328A91AF0C` |

Спільні спостереження: світлий sidebar із темним текстом, світлий canvas, білі картки, crimson/red акцент,
білий текст на crimson CTA, червоні outline buttons, тонкі межі, округлена зовнішня рамка й м’яке затінення.
Вибір у sidebar — рожева плашка з червоною іконкою/текстом; вертикальної червоної рейки немає.
Референси різняться framing/insets і висотою header; header містить search, notification і profile, без workspace/online controls.
Нижче обрано один canonical shell; дрібні розбіжності PNG не переносяться як шість різних компонентів.

<a id="foundations"></a>
## 3. Візуальні принципи

1. Робочий простір оператора: пріоритет зверненню, його власнику та наступній дозволеній дії.
2. Червоний — бренд і акцент вибору; error/destructive мають окремі семантичні ролі й підписи.
3. Інформація групується білими поверхнями та межами, а не великими тінями й декоративними градієнтами.
4. На сторінці одна виразна primary action; другорядні дії — outline/ghost без конкуренції за увагу.
5. Щільність підтримує сканування; важливі числа, одиниці, статуси та кнопки не залежать лише від кольору.
6. UI відображає підтверджений стан backend. Погодження, виконання та фінансовий результат є різними фактами.

## 4. Семантичні кольори

Усі hex нижче — **запропонована нормалізація**, близька до референсів; точними raster swatches вони не оголошуються.
CSS-імена мають префікс `--ds-`; компоненти використовують роль, а не локальний довільний hex.

| Роль / token | Значення | Застосування |
| --- | --- | --- |
| `color-canvas` | `#F5F7F9` | Загальний світлий робочий фон |
| `color-surface` / `surface-subtle` | `#FFFFFF` / `#F3F5F7` | Картки / вторинні плашки |
| `color-text` | `#0B0D14` | Основний текст і заголовки |
| `color-text-secondary` / `text-muted` | `#465268` / `#56637A` | Пояснення / метадані |
| `color-sidebar` / `sidebar-active` | `#FAFBFC` / `#FFF0F3` | Світла навігація / вибір |
| `color-sidebar-text` / `sidebar-text-active` | `#465268` / `#C41230` | Навігація / активна іконка й label |
| `color-primary` / `on-primary` | `#D91836` / `#FFFFFF` | Crimson primary fill та білий label |
| `color-primary-hover` / `primary-active` | `#C91531` / `#B5122B` | Hover / pressed |
| `color-link` / `link-hover` | `#C41230` / `#B5122B` | Текстові посилання й red outline labels |
| `color-selection-bg` / `selection-text` | `#FFF0F3` / `#0B0D14` | Вибраний рядок без вертикальної рейки |
| `color-border` / `divider` | `#DDE2E8` | Декоративні межі поверхонь |
| `color-control-border` | `#7D899A` | Значуща межа input/checkbox/neutral outline button |
| `color-focus` | `#B5122B` | Focus ring на світлих поверхнях |
| `color-pending` / `pending-bg` | `#C41230` / `#FFF0F3` | Канонічний approval-pending badge |
| `color-success` / `success-bg` | `#087F45` / `#E3F8EB` | Підтверджений успіх |
| `color-warning` / `warning-bg` | `#875300` / `#FFF2D5` | Очікування, потреба уваги |
| `color-info` / `info-bg` | `#155CAB` / `#EAF3FF` | Виконується, інформація |
| `color-danger` / `danger-bg` | `#B4232A` / `#FFE6E8` | Помилка, небезпечна дія |
| `color-neutral-status` / `neutral-status-bg` | `#465268` / `#F3F5F7` | Draft, offline, нейтральний стан |
| `color-chart-primary` / `chart-secondary` | `#D91836` / `#E96886` | Crimson/pink series на white chart surface |
| `color-chart-tertiary` / `chart-quaternary` | `#F6A3B4` / `#FACBD4` | Pale-pink fills із додатковими labels/boundaries |
| `color-chart-area` / `chart-boundary` | `#FFE8ED` / `#B5122B` | Decorative area fill / суттєві контрастні межі |

Для дрібних red labels і активної навігації є `color-link`; primary fill має білий label.
Brand red не означає, що клієнт помилився; destructive button обов’язково називає дію, наприклад «Видалити документ».
Notification count зазвичай має pink surface + red label; filled count використовує crimson + white, як selected Open у R3.
Межа `color-border` може бути декоративною, але не є єдиною видимою межею інтерактивного контролу.

### Контраст нормалізованої палітри

Це розрахунок для **вказаних плоских пар**, не підтвердження доступності всього майбутнього UI.

| Foreground / background | Контраст | Рішення |
| --- | --- | --- |
| `#0B0D14` / `#FFFFFF` | 19.41:1 | Основний текст |
| `#56637A` / white / selection-bg | 6.07:1 / 5.49:1 | Метадані, включно з pink surface |
| `#FFFFFF` / `#D91836` | 5.08:1 | Primary label |
| `#FFFFFF` / hover / active | 5.78:1 / 6.80:1 | Hover/pressed label |
| `#C41230` / white / selection-bg | 6.04:1 / 5.47:1 | Link та active navigation |
| `#B5122B` / `#FFFFFF` | 6.80:1 | Focus на світлому |
| `#7D899A` / white / canvas / subtle / selection | 3.55:1 / 3.30:1 / 3.25:1 / 3.21:1 | Значущий control border |
| `#465268` / `#FAFBFC` | 7.60:1 | Sidebar navigation |
| `#C41230` / `#FFF0F3` | 5.47:1 | Pending approval text |
| success / success-bg | 4.57:1 | Текст success badge |
| warning / warning-bg | 5.79:1 | Текст warning/unknown badge |
| info / info-bg | 5.95:1 | Текст running badge |
| danger / danger-bg | 5.52:1 | Текст error badge |

Ціль — WCAG 2.2 AA: 4.5:1 для звичайного тексту; 3:1 для великого тексту та значущих UI/graphic елементів.
24×24 CSS px — AA-мінімум target size з визначеними винятками; наш **запропонований** touch target — 44×44 px.
Перевіряємо реальні background/opacity/hover/focus, а не лише вихідний token. [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/).

## 5. Типографіка, ритм і геометрія

Спостережено нейтральний sans-serif. Точний font з PNG невідомий; **запропоновано** системний sans stack із CSS-файлу.
Якщо команда обере окремий font, потрібні локальні ліцензовані assets і перевірка української кирилиці; remote font import не закладаємо.
База rem — 16 CSS px; масштабування браузера та користувацького шрифту не блокуємо.

| Роль | Size / line-height | Weight | Приклад |
| --- | --- | --- | --- |
| Metric | 36 / 44 px | 700 | Значення KPI, не звичайний текст |
| Page title | 32 / 40 px | 700 | Inbox, Налаштування |
| Section title | 20 / 28 px | 600–700 | Панель або картка |
| Subheading | 16 / 24 px | 600 | Назва фрагмента detail panel |
| Body / control | 14 / 20 px | 400 / 500–600 | Таблиці, форми, повідомлення |
| Metadata | 12 / 16 px | 400–500 | Час, джерело, службова довідка |

Важливі аргументи approval, суми й помилки не стискаються до metadata. Числа KPI/гроші використовують tabular numerals.
Довгі заголовки переносяться; ellipsis припустимий у списку, але detail/accessible name містить повний текст.

| Основа | Запропонована шкала / правило |
| --- | --- |
| Spacing | 4, 8, 12, 16, 20, 24, 32, 40, 48 px; основний rhythm 8 px |
| Radius | 4 px tiny; 6 px compact; 8 px control; 10 px card; 12 px shell/dialog; pill для badge/avatar |
| Borders | 1 px; tab underline 2 px; focus outline 2 px з offset 2 px; sidebar selection без рейки |
| Elevation | Card `0 2px 8px / 4%`; shell `0 2px 12px / 5%`; popover `0 8px 24px / 14%` |
| Icons | 16/20/24 px, outline stroke 1.75; одна узгоджена ліцензована сім’я, без emoji замість дій |
| Motion | 120/180/240 ms; без анімації критичних підтверджень; reduced-motion → 0 ms |
| Layers | base 0, sticky 10, popover 20, overlay 30, dialog 40, toast 50 |

Icons-only control має доступну назву; tooltip є поясненням, а не єдиною назвою. Decorative icons приховані від accessibility tree.

<a id="layout"></a>
## 6. Canonical shell і адаптивність

Оцінено з нових PNG: ширина sidebar приблизно 226–246 px, висота header 61–82 px, зовнішні відступи 0–19 px.
Це виміри растру з різними framing/insets, а не точний вихідний CSS; усі шість — desktop-композиції.
Нормалізуємо світлий framed shell: global search у header, notification і profile праворуч; sidebar selection — pink pill без рейки.
Workspace selector та presence control у нових headers не спостережені. Якщо production потребує context switch,
його додаємо як окремо погоджений запропонований control; R4 Demo account badge є лише demo-індикатором.

| Елемент | Запропонована canonical геометрія |
| --- | --- |
| Outer frame | Inset 12 px на ≥768 px; 8 px mobile; shell radius 12 px, тонка світла межа й м’яка тінь |
| Sidebar / collapsed rail | 240 / 72 px; навігаційні рядки min 44 px; світла поверхня |
| Header | 72 px; у компактному режимі 64 px |
| Page padding / gaps | 24 px desktop, 16 px compact; 16 px між панелями, 24 px між секціями |
| Card padding | 20 px; compact 16 px |
| Page heading | Title + description ліворуч, primary action праворуч; на вузькому екрані перенос |
| Inbox | List 352 px, conversation min 400 px, inspector 344 px; зміна ширин проходить content-fit перевірку |
| Detail panel | 400 px desktop; не зменшувати головний контент до нечитабельної ширини |
| Forms | Дві колонки лише за достатнього місця; читабельна довжина пояснення, max-width визначає форма |

Вкладені flex/grid панелі мають дозволяти shrink через `min-width: 0`/`min-height: 0`; жоден текст не ховається за fixed header/footer.
Звичайні сторінки мають один основний вертикальний scroll; sticky headers не перекривають keyboard focus.
Inbox має незалежні scroll regions списку, transcript і copilot; header діалогу та composer лишаються доступними.
Кожен scroll region має зрозумілу назву; keyboard користувач може вийти з нього без пастки фокусу.

| Ширина viewport | Запропонована поведінка |
| --- | --- |
| ≥1440 px | Повний sidebar; три панелі Inbox лише за достатнього місця з урахуванням frame; table + detail поруч |
| 1200–1439 px | Sidebar/rail за доступною шириною; copilot перемикається у drawer, якщо три панелі не вміщаються |
| 768–1199 px | Rail 72 px; list + conversation лише коли вміщаються; при viewport <896 px — list → conversation/detail, inspector за кнопкою; Settings в одну колонку |
| <768 px | Sidebar як menu drawer; Inbox list → conversation → inspector як окремі views; таблиці → list/detail |

Breakpoints і mobile — **пропозиція**, не спостереження. Рішення залежить також від реального вмісту й 200% zoom.
Дві панелі Inbox потребують 768 px контенту (352 + 16 + 400); rail 72 + page padding 32 + frame insets 24 дають мінімум 896 px viewport.
Повні три панелі потребують 1440 px: sidebar 240 + page padding 48 + panels 1096 + gaps 32 + frame 24.
За меншого доступного місця через zoom або довгий вміст теж переходимо list → conversation/detail із явними Back/inspector controls, без приховування дій.
Таблиця з необхідними порівняльними колонками може мати названий horizontal scroll; не створюємо horizontal scroll усієї сторінки.
На mobile composer враховує екранну клавіатуру та safe area; «Назад» повертає фокус до відкритого рядка.

<a id="components"></a>
## 7. Компоненти та їхні контракти

Назви нижче — пропозиція API компонентів; конкретну UI-бібліотеку або CSS-фреймворк не обрано.
Кожен інтерактивний компонент має default, hover, focus-visible, pressed/selected, disabled, loading та error там, де це має сенс.
Disabled не є способом пояснити відсутність прав: поруч доступна причина; backend однаково перевіряє дію.

| Компонент | Anatomy / variants / sizes | Keyboard та доступність |
| --- | --- | --- |
| `AppShell` | Sidebar, header, main landmark; full/rail/drawer | Skip link до main; один h1; коректний reading order |
| `NavItem` | Icon, label, optional count, pink selected surface + red active content | Звичайний link; `aria-current="page"`; count має значення для назви |
| `Button` | crimson/white primary, red-outline secondary, ghost, destructive; 32/40/44 px | Native button; Enter/Space; loading зберігає label і width, `aria-busy` |
| `IconButton` | Icon 16/20/24; control 32/40/44 px | Accessible name обов’язкове; touch area 44 px, tooltip на hover і focus |
| `TextField` / `SearchField` | Label, input, optional hint/error/clear; 40/44 px | Label association; error через `aria-describedby`; clear — окрема названа кнопка |
| `SelectField` | Native select для простого списку; 40/44 px | Custom combobox лише з повною keyboard/ARIA поведінкою й перевіркою screen reader |
| `SwitchField` | Label + help + switch; 44 px interaction row | Native checkbox або switch role; Space; стан не читається лише з кольору |
| `RadioCardGroup` | Заголовок групи, description, вибір однієї card | Native radios, fieldset/legend; arrows змінюють вибір; focus відмінний від selected |
| `Checkbox` | unchecked/checked/mixed, label | Space; mixed для часткового вибору; select-all scope пояснений |
| `Tabs` | Section tabs або navigation/filter tabs з count | Panels: roving focus, arrows/Home/End; навігація: links; не змішуємо семантику |
| `StatusBadge` | Icon + текст; neutral/success/warning/info/danger | Не button, якщо не інтерактивний; озвучуваний текст; color не єдине кодування |
| `Avatar` / `Presence` | Photo/initials, окремий online marker | Decorative photo при сусідньому імені; presence має текст і timestamp актуальності |
| `Card` / `Section` | Title, optional description/action, body | Семантичний heading; декоративний container не отримує довільний button role |
| `DataTable` | Header, rows, selection, sort, optional pagination | Native table, row labels; sort button + `aria-sort`; окремий control відкриття detail |
| `DetailPanel` | Heading, close, sections, actions; aside або mobile dialog | Desktop aside без focus trap; modal drawer/dialog — focus containment та return |
| `Dialog` | Heading, description, content, actions, close | Focus до heading/безпечної дії; Tab усередині; Escape закриває dialog, не скасовуючи вже надісланої дії |
| `Menu` / `Popover` | Trigger, item list, selected/check state | Trigger expanded state; menu arrows/Escape; звичайний popover не стає menu без відповідних items |
| `Toast` / `InlineAlert` | Short status/error, optional retry/link | Success polite; critical error видимий біля дії; persistent errors не існують тільки в toast |
| `Skeleton` / `EmptyState` | Layout placeholder / reason + next allowed action | Skeleton decorative; container busy; empty/error/loading не підмінюють одне одного |
| `MetricCard` / `Chart` | Value, unit, period, comparison; plot + legend | Доступний summary та еквівалентна data table; названі series/axes |
| `Composer` | Reply/note, textarea, draft state, send, attachments | Tab не відправляє; Enter — новий рядок за замовчуванням, Ctrl/Cmd+Enter — явний send shortcut |
| `ApprovalCard` | Exact action/args, source, actor, expiry, decision controls | Approval label називає погодження; confirm змінює стан, але не оголошує виконання |

Таблиця залишається native table, доки не реалізовано й перевірено весь grid keyboard pattern; не ставимо `role="grid"` лише за вигляд.
Selected row, checkbox selection і keyboard focus — три незалежні стани. Row click не перехоплює роботу links/buttons усередині.
Escape/close для dirty form запитує збереження/відкидання; системний або browser Back враховує той самий стан.

## 8. Форми, збереження та загальні async-стани

| Стан | Візуальна поведінка | Контракт |
| --- | --- | --- |
| Pristine | Поточні збережені значення, primary save неактивна або прихована за узгодженим правилом | Не показуємо «Збережено», поки стан ще не завантажено |
| Dirty | Помітне «Є незбережені зміни», Save/Cancel | Зміни локальні, не означають активації політики |
| Validating | Inline progress без стрибка layout | Перевірка schema/permissions на backend лишається обов’язковою |
| Saving | Save busy, повторний submit заблоковано | Стабільний request/idempotency identity за контрактом API |
| Saved | Коротке підтвердження з актуальною версією/часом | Лише після підтвердження backend |
| Field error | Пояснення поруч із полем, summary із посиланнями | Focus на summary або перше invalid поле; введення збережене |
| Conflict/stale | «Налаштування змінено іншим користувачем», reload/compare | Не перезаписуємо актуальну policy тихо |
| Network/offline | Retry, пояснення про незбережені дані | Невідомий результат write відрізняємо від безпечного повтору read |
| Forbidden | Зрозуміле обмеження та наступний доступний шлях | Не маскуємо під нескінченне loading |

Settings Save й Team role selection використовують той самий explicit-save pattern; radio click сам по собі не змінює роль на сервері.
Для зміни ризикової політики показуємо diff/наслідок та перевіряємо актуальні права; збереження та активація можуть мати окремі дії.
Connection test, credential save, sync і model generation — різні операції зі своїми результатами.
Secret field показує mask/reference; збережені API-ключі не повертаються в UI відкритим текстом.

<a id="screens"></a>
## 9. Settings — R6

Спостережено: tabs Workspace/AI assistant/Approvals/Integrations, двоколонкові cards, pink selected radio і crimson Save з білим label внизу справа.
Вміст: response preferences, analysis switches, automation radios, integration rows, approval rules та preview.
Запропоновано мати одну зону Save/Cancel для поточної форми; при довгому scroll вона не перекриває останнє поле.
Language/tone/emoji описують поведінку відповіді; права інструментів і approval policy відображають окремо.
«Автоматичні low-risk дії» — режим лише для операцій, дозволених backend policy, а не загальне вимкнення guards.
Preview явно позначено як приклад/тест: він не відправляє повідомлення клієнту й не виконує фінансові дії.
Integration row показує configured/connected/degraded/needs-auth; «Connected» не гарантує доступ до всіх операцій.
Analysis switches для tone/sarcasm не роблять оцінку емоцій фактом; вони мають explanation і можливість manual correction.

## 10. Team — R4

Спостережено: три metric cards, member table, selected member і detail із pink permission chips, assignments та role radios.
Канонічний layout — selectable table + detail; вибір person не є bulk selection.
Invite відкриває доступний dialog; pending invitation, active member, suspended і removed мають різні тексти та дії.
Роль і capabilities приходять із backend; UI role badge не є доказом дозволу approve refunds чи publish knowledge.
Зміна role проходить dirty → save → server confirmation; при помилці вибір і причина лишаються видимими.
Staff online/offline — присутність людини; health worker/runtime/інтеграції показується окремо й не копіює online dot.
Assignments показують чисельник, знаменник, одиниці й правило capacity; прогресбар має текстове значення.
Аватар не замінює ім’я; реальні фото та email з демонстраційних PNG не використовуємо як production fixtures.

## 11. Analytics — R5

Спостережено: period selector, чотири KPI, crimson line із pale-pink area fill, pink topic bars, outcomes table і pink/red donut.
Demo data badge обов’язковий для fixtures. «148»/«96%», тренди й усі числа з PNG є прикладами, не production-даними.
Кожна метрика має визначення, період, timezone, freshness і доступні filters; порівняння позначає базовий період.
Відсутні дані — «Немає даних»/«Недостатньо вибірки», а не нуль або вигаданий тренд; zero є реальним виміром.
Success rate розрізняє approval, execution success і feedback acceptance; змішувати ці знаменники заборонено.
Axes та units видимі; усі series мають legend і data table, tooltip доступний із keyboard та не є єдиним джерелом значення.
Crimson/pink series розрізняються labels/markers; area fill і pale segments декоративні, не єдиний носій значення.
`chart-secondary` #E96886 має 3.09:1 лише на white, не canvas; pale #F6A3B4/#FACBD4 самі не проходять 3:1.
Для суттєвих меж додаємо `chart-boundary` #B5122B, direct category/value labels та еквівалентну data table.
Якщо KPI й outcomes table охоплюють той самий період, вибірку та визначення успіху, demo 96% не збігається з 144/(144+13) ≈91.72%; PNG не доводить спільного знаменника, у продукті його визначаємо явно.
Зміна date range показує loading із збереженням зрозумілого контексту; stale data має timestamp, а не вигляд актуальної.

## 12. Inbox — R3

Спостережено: list зі search/filters, transcript із composer, copilot із customer/payment/source/action cards.
Desktop має незалежний scroll кожної панелі; sticky composer не прокручує transcript стрибком при новій події.
Якщо оператор читає вище, нові messages показують «Нові повідомлення»; автопрокрутка лише коли він біля кінця.
List items містять ім’я, тему, preview, channel, timestamp та unread state; accessible name не дублює весь preview без потреби.
Reply та Internal note мають чітку аудиторію: «Клієнту» / «Лише команді»; перемикання не надсилає чернетку автоматично.
Draft saving, saved locally/server-side, sending, sent і failed/unknown delivery показуються окремо; не називаємо draft повідомленням клієнту.
Takeover переводить діалог до staff ownership; нові customer messages не запускають bot автоматично.
UI показує bot/pending_handoff/staff/resolved та відповідального; resume-bot — явна дозволена дія з поясненням наслідку.
Bot typing не продовжує обіцяти відповідь після takeover; уже відправлений business write не вважається скасованим разом із typing.
AI summary має позначку походження/актуальності. «Можливий сарказм» — невпевнена AI-оцінка з ручним перевизначенням.
«72% confidence» у R3 — demo annotation, не доказ каліброваної ймовірності, правильності оцінки або дозволу на дію.
Copilot citations показують тільки використані й доступні джерела; customer/account/payment data проходять актуальну authZ.
Primary action у composer — «Надіслати»; approval іншої бізнес-дії залишається окремим control, не прихованою send-option.

## 13. Knowledge base — R2

Спостережено: category tabs, search, sortable-looking table, selected document, content/detail, source/version і action-rules card.
Upload/import, parsing/indexing, draft/review/published, failed і revoked — різні етапи, не один green Published badge.
Publication status описує редакційний стан; ACL/access описує, хто може читати та використовувати джерело.
Картка «Action rules» відображає окрему backend policy. Текст документа не надає tool permission і не активує guards.
Source link має назву й version; при open перевіряється актуальний доступ. Revoke прибирає недоступні previews/citations у live/replay/history.
Preview і Publish changes у R2 — окремі дії: preview не публікує й не активує документ; publish підтверджується backend та version.
Фраза R2 «cites published sources … in every answer» є demo copy: продукт не обіцяє citation там, де джерело не використано або недоступне.
Empty: ще немає documents; no-results: filter нічого не знайшов; indexing: документ ще не готовий; ці повідомлення різні.
Deleting/revoking показує наслідок для індексу й майбутніх відповідей; content preview не зберігається в browser cache як обхід відкликання.

## 14. AI actions — R1

Спостережено: status metrics, Pending/Running/History tabs, selectable table, action detail, approve/reject і timeline.
R1 містить pink callout «Two matching charges found»; у продукті він показує перевірений факт із джерелом/часом, не AI-припущення як факт.
Selection відкриває detail; checkbox selection не означає право на bulk financial approval.
ApprovalCard до рішення показує точні action/arguments, amount/currency, customer/resource, actor, policy/config version, expiry й наслідок.
Eligibility, approval required, approved та execution result — окремі поля. «Eligible» не означає «Повернення виконано».
Кнопка називається «Погодити повернення», якщо дає approval; підтвердження — «Погоджено, очікує виконання».
Timeline містить перевірені backend events і часові позначки; план/AI proposal відрізняється від фактично завершеного кроку.
Після рішення контролі busy/locked для конкретного action ID. Повторний клік або доставка події не породжує другу дію.
Changed arguments, expired/invalidated approval і втрачена роль вимагають нової перевірки; stale detail оновлюється до рішення.
Unknown outcome після timeout показує «Результат уточнюється» з reconcile/manual-review шляхом; generic Retry для financial write не пропонується.
Reject називає відмову в погодженні; Cancel запитує скасування; жодне з них не обіцяє rollback уже надісланої дії.

<a id="agent-states"></a>
## 15. Єдина мова агентних станів

| Факт backend | Label приклад | Семантичний вигляд | Доступна наступна дія |
| --- | --- | --- | --- |
| Proposal/planned | «Запропоновано» | Neutral + sparkle icon | Переглянути аргументи |
| Pending approval | «Очікує погодження» | Pending rose + clock | Погодити/відхилити за правом |
| Approved/queued | «Погоджено, у черзі» | Info | Переглянути; не повторювати approval |
| Executing | «Виконується» | Info + progress | Дозволене cancel request без обіцянки rollback |
| Succeeded | «Виконано» | Success + check | Переглянути підтверджений результат |
| Failed, відомий результат | «Не виконано» | Danger + reason | Повтор лише за дозволеним backend сценарієм |
| Unknown | «Результат уточнюється» | Warning + question | Reconcile/оператор, без сліпого retry |
| Expired/invalidated | «Погодження втратило чинність» | Neutral/warning | Оновити дані, повторно розглянути |
| Denied | «Дію не дозволено» | Danger/neutral + причина | Доступна ескалація |
| Cancel requested/cancelled | «Запитано скасування» / «Скасовано» | Окремі labels | Дочекатися підтвердження |

UI мапить типізовані стани API, а не вгадує їх із тексту моделі, кнопки або кольору.
У PNG pending варіюється: pink у R1, amber у R3. Канонічний pending — rose; amber лишається для невпевненості/unknown/уваги.
Approval не є execution, execution не є success; optimistic UI припустимий для локального вибору, не для business outcome.
Маємо видимий audit summary дій із доступними actor/time/source; приховані міркування моделі не відображаються.
Після revoke поточний stream закривається й недоступний вміст ховається; вже побачений текст неможливо технічно відкликати з пам’яті людини.
Disconnected/stale stream показує час останнього підтвердження; staff online не підміняє worker/model health.

## 16. Demo copy, локалізація та контент

Референси містять суперечливі приклади refund: R1 «over $20», R2/R6 «above $50», а також «24 hours», «14 days», «all refunds require approval».
Також demo є $29/$12/$10, імена, email, кількість tickets та історичні дати. **Це не бізнес-правила продукту.**
Поведінку визначають конфігурація, актуальна policy, identity/ownership і перевірена бізнес-система; fixture не активує реальну дію.
Approved KB sources є джерелом відповіді лише в межах ACL і актуальності; policy eligibility та право approver перевіряються окремо.

Основна мова документації/майбутнього UI — українська; English fallback явний на рівні словників, без silent mixed-language screens.
Локаль оператора, preferred language клієнта й мова AI-відповіді є різними налаштуваннями.
English preview у R6 попри Ukrainian setting є demo copy, а не вимогою змішувати мови чи ігнорувати вибір користувача.
Дати/час/валюти форматуємо через `Intl` із визначеною locale/timezone; API передає timestamp і currency code, не готовий display string.
Показуємо одиниці: «8 хв 24 с», «29,00 USD» або locale currency format; знак валюти не замінює її код у неоднозначному approval.
Relative time має доступну точну дату й timezone; rollover оновлюється без безперервного screen-reader announcement.
Рядки допускають довшу українську локалізацію, множини та перенос; кнопки не обрізають критичне дієслово.
Тексти дій конкретні: «Зберегти зміни», «Надіслати клієнту», «Додати внутрішню нотатку», «Повернути боту».

<a id="contracts"></a>
## 17. Контракти реалізації та ownership

| Контракт | Вимога до реалізації |
| --- | --- |
| `AppShell` | Не зберігає бізнес-права; отримує navigation items і presentation state; context selector лише якщо окремо погоджений |
| `DataTable<Row>` | Стабільний row ID; selection, sort, pagination і opened detail — окремі controlled states |
| `FormSection` | Label/hint/error IDs, dirty baseline, server validation/conflict; одна узгоджена submit boundary |
| `ConversationView` | `conversationId`, ownership/version, дозволені messages/events; draft audience явна |
| `AgentActionDetail` | Action ID/version, exact args, approval state, execution state, permitted actions і expiry |
| `KnowledgeSourceCard` | Source/version/provenance/status/access; link може стати недоступним і має це коректно відобразити |
| `StatusBadge` | Семантичний state enum + localized label; жодного визначення бізнес-стану за довільним hex |
| `AsyncBoundary` | Loading/empty/error/forbidden/stale стани; retry тільки коли контракт допускає повтор |
| `MetricCard` / `Chart` | Значення + unit + period + freshness + demo flag; accessible data alternative |

Право на дію контролює backend. UI отримує поточні allowed actions, але запит однаково може бути відхилений після зміни policy.
Контракти компонентів не залежать від конкретної неузгодженої бібліотеки; звичайний HTML/native controls є базою семантики.
Tokens не імпортують remote fonts, не містять app selectors та не змінюють runtime; їхнє підключення буде окремою реалізацією.
CSS breakpoint tokens документальні: custom properties не можна напряму використати як native `@media` conditions.

## 18. Версії, зміни й handoff

Design-system.md визначає usage/поведінку; tokens.css — числовий довідник. При розбіжності спочатку погоджуємо правку обох.
Поточний статус — proposal. Після погодження versioned release фіксує tokens, component contracts і visual examples.
Зміна семантики token або keyboard behavior — review з міграційною приміткою; дрібна корекція контрасту теж потребує перевірки consumers.
Новий компонент додається після перевірки повторного використання, anatomy, states, keyboard, localization і backend contract.
Screenshots у references не редагуються; нова версія референсу має новий файл, ID/hash та пояснення відмінності.
Поточний напрям — повністю світлий workspace і sidebar з crimson/pink акцентами; dark theme не входить до цього набору.

<a id="qa"></a>
## 19. План перевірки перед прийманням UI

Це майбутні перевірки, а не твердження про вже досягнуту WCAG-відповідність або реалізовані компоненти.

- [ ] Звірити canonical shell та всі шість screen patterns із R1–R6; розбіжності нормалізації пояснені.
- [ ] Усі кольори беруться із семантичних tokens; crimson primary має білий label, sidebar світлий/pink selected без вертикальної рейки.
- [ ] Перевірити contrast реальних default/hover/focus/selected/error/disabled композицій та chart legends.
- [ ] Пройти UI лише keyboard: skip link, navigation, filters, table controls, detail, composer, dialogs і return focus.
- [ ] Перевірити screen reader names/descriptions, headings/landmarks, sort/selection, form errors та помірні live announcements.
- [ ] Перевірити 200% zoom, 320 CSS px ширини, довгі українські рядки й touch targets без прихованих критичних дій.
- [ ] Inbox: незалежний scroll, new-message indicator, composer/клавіатура/safe area, reply/note audience, focus після Back.
- [ ] Форми: dirty navigation, server validation, stale version, offline, forbidden, повільне save та повторний submit.
- [ ] Agent action: approval≠execution≠success; expired/invalidated/unknown/cancelled/duplicate стани не вводять в оману.
- [ ] Takeover прибирає обіцянку bot reply; staff-owned messages не запускають bot; explicit resume має поточний дозвіл.
- [ ] KB publication≠ACL; revoked content/citations прибираються з live/replay/history; недоступний source не розкриває preview.
- [ ] Analytics: empty/zero/demo/stale відрізняються; визначення метрик, період, одиниці й data table доступні.
- [ ] Reduced motion/forced colors/висока контрастність не прибирають focus, selection або зміст повідомлень.
- [ ] Dashboard і widget залишаються опційними; жодний UI-only крок не стає вимогою headless API setup.

Нормативний орієнтир доступності: [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/).
