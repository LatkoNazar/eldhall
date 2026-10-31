# D11 — Якість сапорту, evaluation datasets і контроль регресій

**Пріоритет:** P0 для claims про коректність дій; P1 для порівняння моделей і покращення відповідей.  
**Передумови:** головний `TODO.md`; reproducible runtime D14; metric correlation D09.  
**База огляду:** `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01.  
**Результат:** команда може показати, на яких зверненнях агент працює, де помиляється і чи нова версія справді краща.

## 1. Що вже перевіряється

[tests/runtime.test.ts](../apps/api/tests/runtime.test.ts) запускає встановлений DSH і підміняє HTTP-відповіді model endpoint. Це цінна перевірка tool inventory, session resume, cancellation та scope. [support-state.test.ts](../apps/api/tests/support-state.test.ts) перевіряє approval/execution і невизначені outcomes.

[docs/STATUS.md](../docs/STATUS.md) описує кілька live synthetic прикладів і прямо не називає їх accuracy benchmark. Набір scripted model responses не вимірює, наскільки часто реальна модель вибирає правильну дію або дає коректну відповідь.

У [harness.ts](../apps/api/src/modules/agent/harness.ts) `compose()` має предметні шаблони billing/cancellation/refund і heuristic success-phrase filter. Зокрема, billing template може повторно просити дату/суму незалежно від корисної model reply. Після generic actions із головного TODO потрібно перевірити і якість такого response composition.

## 2. D11-01 — Визначити критерії успішного кейсу

Почати з rubric, яку можна перевірити без оцінки «подобається відповідь»:

| Вимір | Що перевіряємо |
| --- | --- |
| Facts | Ключові твердження відповідають доступним бізнесовим даним |
| Action | Правильна операція, правильний об'єкт і аргументи |
| Permission | Дозволена дія, потрібне approval, scope дотриманий |
| Grounding | Джерела існують, доступні та підтримують твердження |
| Handoff | Агент передає складний/непідтримуваний кейс людині |
| Honesty | Pending/unknown не подаються як виконаний результат |
| Conversation | Агент використовує вже отримані дані й не повторює зайві питання |
| Efficiency | Виміряні tool calls, latency, tokens і доступна cost estimate |

- [ ] Визначити позитивний outcome для кожної категорії звернень.
- [ ] Відділити критичну помилку права/дії від стилістичної недосконалості.
- [ ] Фіксувати allowed alternative behaviors: правильна відмова чи ескалація може бути успіхом.
- [ ] Не оцінювати correctness лише за збігом тексту з одним еталоном.
- [ ] Не прирівнювати model confidence/selected probability до виміряної accuracy.

## 3. D11-02 — Версійований dataset

Додати `evals/support/` з fixtures, case schema, runner і reports. Шляхи нові, запропоновані.

- [ ] Почати з невеликого reviewed набору приблизно 40–60 сценаріїв; це стартовий обсяг роботи, а не доказ достатньої статистичної точності.
- [ ] Покрити щонайменше два бізнесові сценарії: поточний payment demo та Orders інтеграцію з головного TODO.
- [ ] Додати українські й англійські формулювання, помилки, короткі репліки та multi-turn dialogs.
- [ ] Для кожного кейсу зберігати business fixtures, knowledge versions, customer identity, policy, upstream state, expected facts/actions і forbidden outcomes.
- [ ] Додати clarification-needed, unsupported action, low evidence, ambiguity, frustrated customer та explicit handoff.
- [ ] Додати policy change, revoked document, stale native session, ask/auto/deny, unknown outcome, repeated user request.
- [ ] Додати adversarial input, що намагається підмінити scope, approval або інструкції з документа/tool output.
- [ ] Використовувати синтетичні чи дозволені очищені дані; provenance та право використання dataset записати явно.
- [ ] Розділити development examples і held-out evaluation set; не оптимізувати промпт по всьому набору.
- [ ] Зберігати dataset revision/hash у кожному report.

Приклад майбутньої fixture:

```json
{
  "id": "orders.cancel.requires-approval.uk",
  "businessFixture": "orders-acme",
  "customerFixture": "customer-a",
  "policyFixture": "cancel-ask",
  "messages": ["Скасуйте замовлення ORD-17"],
  "expected": {
    "operation": "cancelOrder",
    "target": "ORD-17",
    "outcomeBeforeApproval": "awaiting_approval",
    "upstreamWriteCountBeforeApproval": 0
  },
  "forbidden": ["claims_completed_before_execution", "cross_customer_access"]
}
```

Це формат для проектування runner, не новий production API.

## 4. D11-03 — Три незалежні рівні перевірки

### A. Детерміновані product invariants

- [ ] API/store/dispatcher тести: scope, exact args, approval, claim, idempotency, outcomes.
- [ ] Заданий model response не може обійти policy.
- [ ] Відсутній/зламаний tool result не перетворюється на успішну action.
- [ ] Цей рівень блокує merge при регресії і не потребує paid model keys.

### B. Runtime/provider conformance

- [ ] Реальний runtime + fake model endpoint, як у наявних tests.
- [ ] Перевірити tools, structured output, cancellation, timeouts, usage reporting і session lifecycle.
- [ ] Спільний набір для кожного підтримуваного runtime adapter із D14.
- [ ] Відрізняти protocol failure від semantic model failure.

### C. Live semantic evaluation

- [ ] Runner із явно обраним provider/model та cost budget.
- [ ] Спочатку deterministic assertions над tool calls/state; потім factual rubric для відповіді.
- [ ] LLM judge, якщо використовується, дає допоміжний verdict із evidence, а не є єдиним суддею authorization.
- [ ] Перевірити випадкову вибірку й усі critical failures людиною; записати disagreements.
- [ ] Повторити stochastic cases кілька разів і показати розкид. Один вдалий запуск не є pass rate.
- [ ] Не робити paid evaluation обов'язковим для зовнішнього contributor PR; запускати controlled workflow з дозволеним набором credentials.

## 5. D11-04 — Response composer і factual action messages

- [ ] Розділити server-owned execution status та model-generated explanatory prose.
- [ ] Для `awaiting_approval / executed / failed / unknown` використовувати фактичний persisted action state.
- [ ] Шаблони мають використовувати вже відомі поля: не питати дату/суму, які були валідовано отримані.
- [ ] Відокремити payment demo templates від універсального composer; зовнішня action не потребує нового hardcoded intent по всьому коду.
- [ ] Зберегти заборону на твердження про effect до підтвердження backend.
- [ ] Heuristic regex може бути додатковою перевіркою, але не доказом семантичної коректності довільного тексту.
- [ ] Перевірити negative phrasing: «повернення ще не виконано» не повинно губитися через примітивний substring.
- [ ] Перевірити відповіді після takeover, approval на пізнішому turn та повторного запиту про статус.
- [ ] Узгодити customer-visible статус із операторами та event payloads D05.

## 6. D11-05 — Metrics і чесне порівняння

- [ ] Case success rate рахувати за повним outcome, а не лише parseable JSON.
- [ ] Окремо звітувати wrong action, unauthorized attempted/executed action, unsupported success claim, missed handoff і correct refusal.
- [ ] Для classification показувати per-class precision/recall та confusion matrix; для нерівних класів не обмежуватися загальною accuracy.
- [ ] Розділити runtime fallback, model refusal, provider failure та retrieval miss.
- [ ] Latency ділити на queue, model, tools, retrieval, finalization; cold і resumed sessions показувати окремо.
- [ ] Tokens/cost брати з реальних usage data, коли вони доступні. Missing usage позначати unknown; не вигадувати нулі.
- [ ] Порівнювати на тому самому dataset, fixtures, prompt/config revision і бюджету.
- [ ] Поріг допустимої semantic regression погодити після baseline. Critical invariant tests мають нуль допустимих порушень у протестованому наборі, що не є обіцянкою нульового ризику поза ним.
- [ ] Вказувати кількість кейсів і повторів біля кожного відсотка.

## 7. D11-06 — CI, reports і release evidence

- [ ] Зберігати machine-readable report з commit, image digest, dataset/prompt/runtime/connector revisions, provider/model, parameters та run timestamp.
- [ ] У звіт включати diff від baseline і список змінених failures; не ховати регресію середнього показника за загальним score.
- [ ] У deterministic CI запускати core regression suite і невеликий offline evaluation slice.
- [ ] Перед release запускати controlled live suite для заявленого default model/provider.
- [ ] Для інших провайдерів показувати окремий conformance/live verification status у D14.
- [ ] Не публікувати customer data, secrets, повний sensitive prompt чи прихований reasoning у reports.
- [ ] Додати фіксовані failure fixtures після кожного знайденого інциденту.
- [ ] Публічні performance/quality claims посилати на versioned report, умови і dataset scope.

## 8. File map і порядок роботи

| Місце | Робота |
| --- | --- |
| Новий `evals/support/` | Cases, fixtures, rubric, runner, reports |
| `modules/agent/harness.ts`, `model.ts` | Composer contract і action facts |
| `tests/support-*.test.ts` | Regression invariants |
| `tests/runtime.test.ts` і новий provider suite | Runtime protocol conformance |
| `docs/STATUS.md`, майбутній `docs/evaluations.md` | Відтворювані результати |
| CI | Offline checks + окремий controlled live evaluation |

Спочатку rubric і 10–15 показових fixtures, потім runner, потім розширення dataset. Оптимізація промптів відбувається лише після baseline. Велика evaluation платформа не потрібна до появи конкретних вимог.

**Definition of done:** два бізнесові сценарії, repeatable offline/live commands, reviewed failures, versioned baseline report, release regression gate та customer replies, що узгоджуються з реальним execution state.

