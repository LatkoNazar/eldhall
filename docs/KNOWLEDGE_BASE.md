# Knowledge base (v2, unified)

One knowledge-base tool for the whole product. It combines three earlier pieces:

| From | What we kept |
| --- | --- |
| `main` (support workspace) | `support_knowledge` rows as the single source of truth: versions, draft → published → revoked, business scope, operator CRUD in **База знань**, config bootstrap (`SUPPORT_CONFIG_FILE`), `sourceRefs` validation in `completeTurn`, the DSH `search_knowledge` tool, Insights drafts |
| `feat/knowledge-base` (our RAG branch) | heading-aware chunking, UA/EN terms (light stemming + domain synonyms), BM25 + vector search fused with RRF, per-document diversification, similarity floor, retrieval audit, operator "test retrieval" panel |
| `feat/ws-security` (Rostyslav's skills) | the two-layer SKILL.md format: universal procedures + per-business fact sheets with `version`/`status` in frontmatter, imported into the same config |

What we deliberately did **not** carry over: a second set of tables (`kb_*`), pgvector, URL import and file upload. `CLAUDE.md` forbids new infra for the MVP, and main already persists documents. Those can come back behind the same retriever interface after the hackathon.

## How a turn uses it

```
customer message
  └─ harness.runTurn
       ├─ snapshot: published support_knowledge (id, version, content) + enabled skills
       ├─ ctx.searchKnowledge(query)  ← RulesModel and the DSH `search_knowledge` tool call this
       │     └─ knowledgeRetriever.search(snapshot, query)
       │          chunks (cached by id:version:hash) → BM25 + cosine → RRF → ≤5 docs × ≤2 passages
       │          returns { id, title, version, content: matched passages, section }
       │          audit: knowledge.searched {hits:[{id,version,section,score}]}
       ├─ assertActive(): any retrieved/snapshotted source revoked or re-versioned → 409, no output
       └─ completeTurn(..., sourceRefs = sources retrieved in this turn)
```

- **Only published sources** of the customer's business are ever indexed for a turn; drafts and revoked versions never reach the model.
- **sourceRefs = what the agent actually retrieved.** Before v2 every reply referenced *all* published documents, so revoking any document hid every AI reply of the business. Now only replies that used the revoked document are hidden.
- **No reindex job.** The index is an in-process cache keyed by `(id, version, content hash)`; a publish shows up in the next turn, the old version's chunks are dropped.
- The `searchKnowledge` contract (`{id,title,content,version}`) is unchanged, so `model.ts` and `runtime/dsh-model.ts` need no edits; DSH also receives `section`.

## Retrieval

| Step | Detail |
| --- | --- |
| Chunking | `##`/`###` sections, path `Title › Section`; sections < 60 chars fold into the next one, > 900 chars split on paragraphs with one-sentence overlap |
| Terms | NFKC, lower-case, UA/EN stop words, light suffix stemming, synonym groups (`двічі = twice = duplicate`, `грн = UAH = price`, …) |
| Lexical | BM25 (k1 = 1.2, b = 0.75) over terms |
| Vector | `local:hashing-v1:768` — signed feature hashing of terms + character trigrams; cosine; vector-only hits need similarity ≥ 0.22 |
| Fusion | RRF (k = 60); passages below 0.6 × top score are cut; max 2 passages per document, top 5 documents |

`Embedder` is an interface: a hosted embedding model can replace the hashing embedder without touching the harness.

## Operator surface

- **База знань** page (existing): create, edit, publish, revoke.
- **Перевірка пошуку** panel (new, same page): `GET /api/v1/knowledge/search?q=&businessId=&k=` — the exact passages, ranks and similarity the agent would get.
- **Налаштування → Виконання**: "Пошук знань: гібридний".

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
| `<slug>/<doc>/SKILL.md` | knowledge source: `metadata.title`, `category`, `version` (`v2` → 2), `status` Published/Draft, `source` appended as «Джерело» |

Ids are derived from business id + layer + name, so re-importing updates the same rows; the bootstrap applies a row only when its version/revision is higher than the stored one. The business must exist in the config (`businesses[].slug`).

## Files

Own: `apps/api/src/modules/knowledge/{text,embeddings,retriever,skill-md}.ts`, `apps/api/src/scripts/kb-import-skills.ts`, `apps/api/tests/knowledge.test.ts`, `apps/frontend/src/components/KnowledgeSearchTest.tsx` (+ test), this file.

Touched (owners should review): `agent/harness.ts` (WS4), `support/routes.ts`, `support/factory.ts`, `docs/API_CONTRACTS.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md` (WS1), `pages/Resources.tsx` (WS2).
