# D12 — Життєвий цикл знань, provenance і кероване відкликання

**Пріоритет:** P1; відкликання доступу й відсутність витоку джерел — P0.  
**Передумови:** головний `TODO.md`; scoped identity D07; storage/performance D10; quality fixtures D11.  
**База огляду:** `858985f38b82e4e26dafb563e4e794ff01cc9196`, 2026-11-01.  
**Результат:** бізнес може оновлювати знання, бачити використані джерела й розуміти, чому відповідь стала застарілою.

## 1. Наявна реалізація і точна прогалина

У репо вже є draft/publish/revoke, versioned knowledge, audience/plan filtering, chunking, BM25 + embeddings + RRF, optional pgvector та external Qdrant. Дивитися [retriever.ts](../apps/api/src/modules/knowledge/retriever.ts), [vector-store.ts](../apps/api/src/modules/knowledge/vector-store.ts), [qdrant.ts](../apps/api/src/modules/knowledge/qdrant.ts), [KNOWLEDGE_BASE.md](../docs/KNOWLEDGE_BASE.md), [EXTERNAL_DATA.md](../docs/EXTERNAL_DATA.md).

У [harness.ts](../apps/api/src/modules/agent/harness.ts) `runTurn` формує `sourceRefs` з усіх eligible local documents. Коментар пояснює причину: native session або історія може повторно використати факт без нового search. `visibleMessages` приховує відповідь після зміни/відкликання будь-якої такої dependency.

Це свідомо консервативна поведінка. Її продуктова ціна: зміна фактично невикористаного документа може приховати стару відповідь. Водночас [API_CONTRACTS.md](../docs/API_CONTRACTS.md) говорить про лише retrieved sources — документацію слід узгодити з кодом до будь-яких обіцянок.

Заміна `sourceRefs = all` на `sourceRefs = thisTurnHits` без обліку session/history dependencies може повернути відкликані факти. Ця задача має зберегти чинну межу доступу.

## 2. D12-01 — Визначити життєвий цикл source

- [ ] Єдині stable source ID та immutable revisions; новий content або ACL створює нову ревізію.
- [ ] У source metadata зберігати business, origin, title, current/published revision, audience/plan policy, ingest/index state, timestamps.
- [ ] Відокремити source content revision, ACL revision і embedding/index revision.
- [ ] Описати дозволені переходи: draft → validated → published; publish update; revoke; archive/delete.
- [ ] Publish не виконує business tools і не надає permissions агенту.
- [ ] External source має явний locator і version identity; URL сам по собі не є immutable revision.
- [ ] Повтор імпорту того самого content hash не створює нескінченні дублікати.
- [ ] Видалення/відкликання фіксує tombstone, щоб старий config чи import retry не повернув source.
- [ ] History для audit і customer-visible current guidance мають різні access policies.

## 3. D12-02 — Розділити citations і context dependencies

Запропонована модель:

```ts
type SourceRef = {
  businessId: string;
  sourceId: string;
  revision: string;
  chunkId?: string;
  contentHash: string;
};

type AnswerEvidence = {
  citations: SourceRef[];
  contextDependencies: SourceRef[];
  parentMessageIds: string[];
  runtimeContextRevision: string;
};
```

- [ ] `citations` — перевірені посилання, якими пояснюється відповідь користувачу.
- [ ] `contextDependencies` — джерела, чиї дані могли вплинути через retrieved context, історію або native session; це може бути ширший набір.
- [ ] Tool gateway записує actual retrieved source/chunk revisions у run evidence.
- [ ] Посилання, запропоноване моделлю, перевіряється проти доступних evidence; невідомий ID не стає достовірною citation.
- [ ] Dependency closure включає parent assistant messages, які потрапили в новий prompt.
- [ ] Native session отримує versioned context ledger. Після revoke/ACL change не можна повторно використовувати сесію зі stale залежностями.
- [ ] Якщо повну transitive provenance не можна встановити, зберегти консервативне fencing/reset для цього шляху й позначити provenance mode.
- [ ] Hash обчислюється з канонічного metadata, без приватних credential values.
- [ ] Evidence для external tools не змішується з доказом завершення action; action success бере дані з execution ledger.

**Готово:** зміна unrelated source не приховує відповідь, залежності якої достовірно відомі; revoke реально використаного source блокує його повторне використання через search, history і warm session.

## 4. D12-03 — Ingestion та index jobs

- [ ] Відокремити fetch/parse/normalize/chunk/embed/index/publish стадії з persisted progress і failure reason.
- [ ] Використовувати наявні PostgreSQL/job механізми; новий окремий broker не потрібен без виміряної причини.
- [ ] Import job ідемпотентний за source + input revision/hash; повтор після збою продовжує роботу.
- [ ] Обмежити file size, decompressed size, parser resource limits, chunk count і embedding batch budget.
- [ ] Local file import і remote URL import мають окремі правила; egress allowlist не обходиться redirects чи references.
- [ ] Спочатку підтримувати якісно задокументовані формати, які вже є у продукті. PDF/OCR/інші формати додавати з fixtures і чітким quality status.
- [ ] Не індексувати hidden instructions як executable skills і не перетворювати source content на permissions.
- [ ] Publication атомарно перемикає active revision; незавершений index не виглядає готовим.
- [ ] Якщо дозволений lexical fallback до завершення embeddings, показувати `indexMode/degradedReason` явно.
- [ ] Cancel job не видаляє вже опубліковану стару revision.
- [ ] Operator бачить помилку конкретного source та може retry без повторної публікації дублів.

## 5. D12-04 — Index migration і пошук

- [ ] Embedder ID містить provider/model/dimensions/revision; vectors різних просторів не змішуються.
- [ ] Reindex будує нову index revision окремо, перевіряє її й перемикає active pointer.
- [ ] Перевірити business scope для `reindex/clear` і cache invalidation; зміна одного бізнесу не повинна очищати чужі активні дані.
- [ ] Узгодити target SQL/index plan із D10: не завантажувати всі document bodies для кожного великого KB search.
- [ ] Audience/plan/business filters застосовуються до retrieval і повторно до output validation.
- [ ] Показувати в diagnostic search score components, filters, selected source versions і degraded mode без прихованих секретів.
- [ ] Усі caches мають version-aware keys, bounds і explicit invalidation.
- [ ] Не змінювати relevance thresholds без D11 retrieval/answer fixtures.

## 6. D12-05 — External knowledge та недоступність

- [ ] Відрізняти source revoked, source changed, source temporarily unavailable і scope denied.
- [ ] Для customer guidance з неперевіреного external source зберегти fail-closed behavior, але дати зрозумілий reason.
- [ ] Original historical message лишається в дозволеному audit context; hidden customer rendering не має руйнувати сам запис.
- [ ] External references мають bounded validation budget і кеш, що враховує business, ACL і revision.
- [ ] Status endpoint або provider version check не може підмінити trusted business binding.
- [ ] Втрата external source не дає автоматичного дозволу використати локальну KB іншого scope.
- [ ] Перевірити зміни джерела між retrieval і final message commit.
- [ ] При downgrade/restart старі validation snapshots не повертають revoked content у native session.

## 7. D12-06 — UI, data lifecycle і зрозумілі пояснення

- [ ] Source view: current/published version, indexing state, origin, audience, last error і залежні відповіді.
- [ ] Answer view: customer-safe citations, поточна validity, відмінність між історичним текстом і чинною рекомендацією.
- [ ] Preview перед revoke/update показує кількість залежних messages, без завантаження всього transcript у браузер.
- [ ] Відповідь «джерело недоступне» не повинна виглядати як видалений user message.
- [ ] Export/import knowledge package включає metadata та checksums, а credentials задаються в deployment.
- [ ] Retention D07 охоплює raw uploads, normalized text, chunks, embeddings, source versions і runtime copies.
- [ ] Для external read-only sources Eldhall видаляє власні caches/refs і встановлює exclusion/tombstone; фізичне видалення remote vectors/content виконує source owner або окремий authorized deletion connector. Не обіцяти cleanup систем, які Eldhall не контролює.
- [ ] Customer data erasure не відновлюється через повторну індексацію старого artifact.
- [ ] Audit зберігає хто/коли publish/revoke, origin revision і причину зміни.

## 8. Перевірки

- [ ] Relevant source update → dependent answer invalidated; unrelated update → verified independent answer remains.
- [ ] Multi-turn без нового search не повторює відкликаний факт.
- [ ] Warm DSH session і recovered turn поважають нові ACL/source revisions.
- [ ] Draft/internal/foreign-business knowledge не виходить у customer context.
- [ ] Concurrent publish/revoke не створює змішану revision відповіді.
- [ ] Failed embedding batch не пошкоджує старий активний index.
- [ ] Reindex одного бізнесу не прибирає чужі vectors.
- [ ] External outage, permission denial і permanent revoke відображають різні діагностичні причини.
- [ ] Deleted customer/source відсутній у model-accessible caches і native sessions.
- [ ] Metrics не називають невідомі dependencies «точними citations».

## 9. Порядок і evidence

1. Узгодити поточну документацію з conservative behavior.
2. Додати evidence types і fixtures; instrument retrieval без зміни гарантій.
3. Реалізувати dependencies для product history і reset/native session strategy.
4. Лише після negative tests звузити invalidation з all-eligible до доведеного dependency closure.
5. Додати ingestion/index lifecycle, UI та performance improvements.

**Definition of done:** migration і fixtures для старих messages, відтворюваний revoke/update сценарій, чесна provenance mode, versioned index lifecycle, доказ business isolation та актуальна документація. Складний document workflow editor не потрібен для цього результату.

