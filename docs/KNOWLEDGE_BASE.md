# Knowledge base (v2, unified)

For an existing centralized Qdrant collection, use the read-only `externalKnowledge` connector described in [Existing company data sources](EXTERNAL_DATA.md). It queries the company's corpus directly instead of populating local knowledge rows. The sections below describe the built-in local knowledge mode.

One knowledge-base tool for the whole product. It combines three earlier pieces:

| From | What we kept |
| --- | --- |
| `main` (support workspace) | `support_knowledge` rows as the single source of truth: versions, draft → published → revoked, business scope, operator CRUD in **База знань**, config bootstrap (`SUPPORT_CONFIG_FILE`), `sourceRefs` validation in `completeTurn`, the DSH `search_knowledge` tool, Insights drafts |
| `feat/knowledge-base` (our RAG branch) | heading-aware chunking, UA/EN terms, BM25 + vectors fused with RRF, local / OpenAI / Google embeddings (768 dims), pgvector HNSW index, index version per embedder + reindex, audience (customer/internal) and plan scoping, version history, URL import with SSRF protection, file upload, retrieval audit, operator "test retrieval" panel |
| `feat/ws-security` (Rostyslav's skills) | the two-layer SKILL.md format: universal procedures + per-business fact sheets with `version`/`status`/`audience`/`plans` in frontmatter, imported into the same config |

## How a turn uses it

```
customer message
  └─ harness.runTurn
       ├─ snapshot: published support_knowledge (id, version, content, audience, plans) + enabled skills
       ├─ ctx.searchKnowledge(query)  ← RulesModel and the DSH `search_knowledge` tool call this
       │     └─ retriever.search(snapshot, query, { audience: 'customer', plan: customer.plan })
       │          chunks (cached / pgvector by id:version:hash) → BM25 + cosine → RRF → ≤5 docs × ≤2 passages
       │          returns { id, title, version, content: matched passages, section }
       │          audit: knowledge.searched {hits:[{id,version,section,score}]}
       ├─ assertActive(): any snapshotted source revoked or re-versioned → 409, no output
       └─ completeTurn(..., sourceRefs = eligible published source snapshot)
```

- **Only published, customer-audience sources of the customer's business, for all plans or the customer's plan** reach the agent. Drafts, revoked versions and `internal` playbooks never do.
- **sourceRefs conservatively cover the eligible published snapshot.** The native session and product history can reuse earlier source facts without a new search. Until transitive provenance tracking exists, changing or revoking an eligible source hides replies fenced by that version, including follow-ups with no fresh retrieval. Internal and other-plan sources are excluded from the customer snapshot. Retrieval audit events separately identify the passages actually searched in each turn.
- **Embedding model down → lexical mode.** Search keeps working on BM25 and reports `mode: 'lexical'`; document vectors are retried on the next turn.
- The `searchKnowledge` contract (`{id,title,content,version}`) is unchanged, so `model.ts` and `runtime/dsh-model.ts` need no edits; DSH also receives `section`.

## Retrieval

| Step | Detail |
| --- | --- |
| Chunking | `##`/`###` sections, path `Title › Section`; sections < 60 chars fold into the next one, > 900 chars split on paragraphs with one-sentence overlap |
| Terms | NFKC, lower-case, UA/EN stop words, light suffix stemming, synonym groups (`двічі = twice = duplicate`, `грн = UAH = price`, …) |
| Lexical | BM25 (k1 = 1.2, b = 0.75) over terms |
| Vector | `KB_EMBEDDINGS_PROVIDER`: `local` (hashing, no key, floor 0.22), `openai` (`text-embedding-3-small`, floor 0.30), `google` (`gemini-embedding-001`, floor 0.50); always 768 dims |
| Storage | Postgres store + pgvector → `support_knowledge_chunks` (HNSW cosine, `ef_search` 200), vectors survive restarts; otherwise an in-process cache |
| Fusion | RRF (k = 60); passages below 0.6 × top score are cut; max 2 passages per document, top 5 documents |

The embedder id (`provider:model:768`) is the index version. Changing provider or model → `POST /knowledge/reindex` re-embeds published sources and drops the other embedder's vectors (the panel shows "застарілих" until then).

## Data

Migration `0006_knowledge.sql`:

- `support_knowledge` + `audience` ('customer' | 'internal', default customer), `plans` jsonb (empty = all), `source_url`.
- `support_knowledge_versions`: a trigger stores every saved version (draft, published, revoked) — the history panel.
- `support_knowledge_chunks` (only when the `vector` extension is available; created in `public`): passages, `vector(768)`, `tsvector`, HNSW + GIN indexes. Use `compose.knowledge.yaml` (image `pgvector/pgvector:0.8.0-pg17`) to get it; without it everything works with in-memory vectors.

## Operator surface (База знань)

- Create / edit: title, category, **хто бачить** (клієнти або лише команда), **тарифи**, content; publish / revoke; **історія версій**.
- **Імпорт джерела**: from an allow-listed https page (`KB_URL_ALLOWLIST`; private, link-local and metadata addresses refused at connect time, no cross-host redirects, 1 MB / 8 s caps) or a `.md`/`.txt`/`.html` file ≤ 512 KB. Both create **drafts**.
- **Перевірка пошуку**: as a customer (with plan) or as staff (with internal sources); shows ranks, similarity, index (pgvector / memory, embedder, chunk count) and **Переіндексувати**.

API (operator token): `GET /knowledge/search`, `GET /knowledge/index`, `POST /knowledge/reindex`, `GET /knowledge/:id/versions`, `POST /knowledge/import-url`, `POST /knowledge/upload`; `POST/PATCH /knowledge` accept `audience` and `plans`.

## SKILL.md packs → support config

```bash
cd apps/api
npx tsx src/scripts/kb-import-skills.ts ../../knowledge/skills eldhall ../../examples/support.config.json          # dry run, prints merged JSON
npx tsx src/scripts/kb-import-skills.ts ../../knowledge/skills eldhall ../../examples/support.config.json --write  # writes it
```

| SKILL.md | Becomes |
| --- | --- |
| `universal/<name>/SKILL.md` | skill `universal/<name>`, revision = `metadata.version` |
| `<slug>/<slug>-assistant-settings/SKILL.md` | skill `<slug>/assistant-settings` (loaded every turn; grants no tools) |
| `<slug>/<doc>/SKILL.md` | knowledge source: `metadata.title`, `category`, `version` (`v2` → 2), `status` Published/Draft, `audience`, `plans`, `source` → `sourceUrl` |

Ids are derived from business id + layer + name, so re-importing updates the same rows; the bootstrap applies a row only when its version/revision is higher than the stored one.

## Configuration

```
KB_EMBEDDINGS_PROVIDER=local        # local | openai (OPENAI_API_KEY) | google (GEMINI_API_KEY)
KB_EMBEDDINGS_MODEL=                # default per provider
KB_URL_ALLOWLIST=[]                 # e.g. ["help.example.com","*.example.org"]; empty = URL import off
```
