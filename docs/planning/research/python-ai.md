# Python AI service: stack and RAG pipeline recommendation (SmartDoc AI)

*Verified against live sources on 2026-09-25. Anything I could not verify is marked **[unverified]**.*

## 0. Decisions at a glance

| Area | Recommendation | One-line rationale for the interview |
|---|---|---|
| Framework | **Thin stack**: official `openai` SDK, `langchain-text-splitters` and raw SQL through psycopg 3. No LangChain or LlamaIndex vector store or chains. | Drizzle owns the schema. The framework vector stores either create their own tables or add their own filter language. Hybrid search, the cache and cost accounting are the parts I want to show, so I don't hide them behind a framework. |
| DB access | `psycopg[binary,pool]` 3.3 (async pool) with `pgvector` 0.5, SQL in repository modules, plus a schema-contract test | No schema of its own, no second migration tool, and the SQL is readable in the interview |
| Vector column | `halfvec(1536)` (text-embedding-3-small), HNSW `halfvec_cosine_ops` | Half the storage, and HNSW can index up to 4,000 dims |
| PDF | **pypdf 6.19** (BSD, pure Python), section headings from the PDF outline (bookmarks) plus a regex fallback. Swap in pypdfium2 if quality is poor. | Tiny ARM64 image and no AGPL. PyMuPDF is AGPL; Docling pulls in torch. |
| Chunking | Split by section first, then recursive token splitting at **500 tokens with 75 overlap** (cl100k_base). Track page ranges per chunk. | In NVIDIA's benchmark, 512–1024-token chunks did best among token-based splits. Page ranges make citations exact. |
| Retrieval | **Hybrid** (tsvector plus pgvector, fused with RRF k=60 in one SQL query) with iterative scans. Answer "I don't know" below a similarity floor. **Reranking: off by default**, FlashRank behind a flag in the eval. | Measurable ablation, and skipping the LLM when nothing relevant is found saves money |
| Semantic cache | Postgres table scoped by `(user_id, scope_hash)`. Exact match first, then cosine ≥ 0.95 (tuned). Invalidated implicitly through the scope hash. | Costs no extra API call, because the query embedding is needed for retrieval anyway |
| Streaming | FastAPI **native SSE** (≥0.135) → NestJS raw `@Post` + `fetch` pass-through with `tee()` → React `fetch` + `eventsource-parser` | `EventSource` cannot POST or send a Bearer token. Nest `@Sse()` is GET-only. |
| Jobs | **Postgres queue** (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`), hand-rolled, in a separate `ai-worker` container | The job row is written in the same transaction as the document row (a transactional outbox), with no extra infrastructure |
| Deps | **uv 0.12.19**, committed `uv.lock`, multi-stage arm64 Dockerfile | Works like yarn.lock for Python and is much faster than pip or Poetry |

---

## 1. LangChain vs LlamaIndex vs a thin stack

**Verified facts**
- **LangChain**: `langchain` 1.4.2, `langchain-core` 1.6.5, `langchain-openai` 1.6.6, `langchain-text-splitters` 1.1.2. Version 1.0 went GA with a promise of **no breaking changes until 2.0**. v1 refocused on agents (`create_agent` on LangGraph). Legacy chains, retrievers, the indexing API and hub moved to **`langchain-classic`**.
- **LlamaIndex**: `llama-index-core` **0.14.25**, still 0.x. 0.14.0 included a breaking dependency bump (workflows 2.0).
- **pgvector integrations and the schema they impose**
  - `langchain-postgres` 0.0.18, `PGVectorStore`: can map onto an **existing table** (`table_name`, `id_column`, `content_column`, `embedding_column`, `metadata_columns`, `metadata_json_column`). However, it uses its own filter DSL (`$eq`, `$in`, …) and its own hybrid config, and it pulls in SQLAlchemy[asyncio], asyncpg, psycopg and numpy. It **pins `pgvector<0.4`**, which conflicts with pgvector-python 0.5.0. The legacy `PGVector`, with fixed `langchain_pg_collection`/`langchain_pg_embedding` tables, is deprecated.
  - `llama-index-vector-stores-postgres` 0.9.0 **creates its own table `data_<table_name>`** (`id`, `text`, `metadata_`, `node_id`, `embedding`, plus `text_search_tsv` for hybrid). It cannot use a custom schema and pulls in psycopg2-binary, asyncpg and SQLAlchemy.
- **Token and cost accounting**: LangChain has `usage_metadata` and `get_usage_metadata_callback()`. When streaming, you need `stream_usage=True`, and there have been bugs where streaming and non-streaming metadata don't match (issues #30390, #33717). The OpenAI SDK returns `usage` directly, including `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`. Reasoning tokens are **billed as output**.

| Criterion | LangChain 1.x | LlamaIndex 0.14 | Thin (OpenAI SDK + splitters + SQL) |
|---|---|---|---|
| API stability | Good (1.x promise) | 0.x, frequent minor-version breaks | The OpenAI SDK is the only fast-moving dependency (3.x) |
| Custom pgvector schema owned by Drizzle | Partial (column mapping, but its own DSL and dependency pins) | **No** (creates its own table) | **Full** |
| Hybrid RRF + per-user filter + `SET LOCAL` iterative scan in one query | Via its config, opaque | Via its table, opaque | Explicit SQL you can explain line by line |
| Usage/cost including cached and reasoning tokens | Works; streaming needs care | Callback handlers | Native in the `response.completed` event |
| Streaming into FastAPI SSE | `astream` (extra layer) | Streaming response wrapper | `async for ev in stream` → `yield ServerSentEvent` |
| Image size / dependency surface | Medium | Large | Small |

**Recommendation: the thin stack.** The author originally listed LangChain, so keep it where it adds value. The interview line: "I evaluated LangChain 1.x. I use `langchain-text-splitters` because it's mature and pure Python. I didn't use its vector store or chains, because my schema is owned by Drizzle migrations and the retrieval SQL (hybrid, tenant filter, iterative scan) is the part I want to control and measure. If we add multi-step agentic flows, I'd bring in LangGraph and wrap my retriever as a tool."

---

## 2. Accessing pgvector from Python and schema ownership

| Option | Imposes its own schema? | Notes |
|---|---|---|
| **psycopg 3 + pgvector-python** | No | Async pool, `register_vector_async`, `Vector`/`HalfVector`/`SparseVector` types. Recommended. |
| SQLAlchemy 2 (Core or ORM) | No, but you duplicate the models | Tempts you to add Alembic, which would compete with drizzle-kit |
| langchain-postgres `PGVectorStore` | Maps onto a custom table | Own filter DSL; `pgvector<0.4` pin |
| LlamaIndex `PGVectorStore` | **Yes** (`data_*`) | Not compatible with Drizzle ownership |

**Pattern**: Drizzle is the **single source of truth** for DDL. Python gets a least-privilege DB role, for example `SELECT, INSERT, DELETE ON chunks, semantic_cache`, `INSERT ON query_logs`, and `SELECT, UPDATE ON ingestion_jobs, documents`. CI runs `drizzle-kit migrate` against a Postgres service container and then `pytest tests/test_schema_contract.py`. That test asserts the columns and types Python depends on via `information_schema` and `pg_indexes`, so schema drift fails the build.

```python
# app/db.py
from psycopg_pool import AsyncConnectionPool
from pgvector.psycopg import register_vector_async

async def _configure(conn):  # runs for each new pooled connection
    await register_vector_async(conn)  # needs CREATE EXTENSION vector to have run first

pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=10,
                           configure=_configure, open=False)
# FastAPI lifespan: await pool.open() ... await pool.close()
```

**Drizzle schema** (drizzle-orm 0.45.3 and drizzle-kit 0.31.11 are the latest stable versions). `vector`, `halfvec`, `sparsevec` and `bit` are native. `tsvector` needs a `customType`. The index API supports `.using()`, `.op()`, `.with()` and `.where()`.

```ts
import { sql, SQL } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, halfvec, index, uniqueIndex, customType } from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),                 // Cognito sub
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  sectionPath: text('section_path'),                 // "3 Leave > 3.2 Sick leave"
  pageStart: integer('page_start').notNull(),
  pageEnd: integer('page_end').notNull(),
  charStart: integer('char_start').notNull(),
  tokenCount: integer('token_count').notNull(),
  contentHash: text('content_hash').notNull(),       // sha256(normalized content)
  embeddingModel: text('embedding_model').notNull(), // enables blue/green re-embedding
  embedding: halfvec('embedding', { dimensions: 1536 }).notNull(),
  tsv: tsvector('tsv').generatedAlwaysAs((): SQL =>
    sql`to_tsvector('english', coalesce(${chunks.sectionPath}, '') || ' ' || ${chunks.content})`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('chunks_embedding_hnsw').using('hnsw', t.embedding.op('halfvec_cosine_ops')).with({ m: 16, ef_construction: 64 }),
  index('chunks_tsv_gin').using('gin', t.tsv),
  index('chunks_user_doc').on(t.userId, t.documentId),
  index('chunks_hash').on(t.userId, t.contentHash, t.embeddingModel),
  uniqueIndex('chunks_doc_chunk').on(t.documentId, t.chunkIndex),
]);
```

drizzle-kit **does not create extensions**. Add a first custom migration with `drizzle-kit generate --custom` containing `CREATE EXTENSION IF NOT EXISTS vector;`. Check the generated SQL: past bugs quoted the vector type.

---

## 3. PDF parsing

| Library | License | Weight / ARM64 | Page numbers | Headings | OCR |
|---|---|---|---|---|---|
| **pypdf 6.19.0** | BSD-3 | Pure Python, **no required deps** | Per page | Outline (bookmarks) via `reader.outline` + `get_destination_page_number()`; font size via `visitor_text` | No |
| pypdfium2 5.13.0 | BSD-3/Apache-2 | About 2.7 MB aarch64 wheel | Per page | No | No |
| pymupdf / pymupdf4llm 1.28.2 | **AGPL-3.0 or commercial** | 5 MB wheel; 4llm now pulls `pymupdf_layout` (onnxruntime, numpy, networkx; **also AGPL**) | `page_chunks` | Yes (layout GNN) | Yes |
| docling 2.130.0 | MIT | The `standard` extra pulls **torch, torchvision, transformers**, docling-ibm-models, rapidocr, i.e. GBs | Yes | Best | Yes |
| unstructured 0.27.8 `[pdf]` | Apache-2 | unstructured-inference, pdf2image (poppler), tesseract, google-cloud-vision, pikepdf, …; heavy | Yes | Yes | Yes |

**Recommendation: pypdf.** An "enterprise" product should not ship AGPL code without deciding that deliberately; that's a good licensing point to raise in the interview. It keeps the image tiny and gives you pages for free. For section headings:
1. Walk `reader.outline` recursively and map each bookmark to its page, giving a section path per page. Manuals and policies usually have bookmarks.
2. If there is no outline, use a line regex such as `^(\d+(\.\d+)*\.?|Article \d+|§\s?\d+)\s+\S.{0,80}$`.
3. Clean up: remove lines that repeat on at least 50% of pages (headers and footers, after normalizing digits), de-hyphenate line breaks, collapse whitespace.

**Scanned PDFs are out of scope.** Detect them (for example, fewer than 20 extractable characters on more than half the pages) and fail the job with the code `NO_TEXT_LAYER`, which the UI shows as a clear message. Future option: Textract or OCR. Also enforce limits such as ≤25 MB and ≤500 pages, and reject encrypted PDFs as non-retryable.

---

## 4. Chunking

- **Split by section first**: never let a chunk cross a section boundary. Inside a section, use `RecursiveCharacterTextSplitter.from_tiktoken_encoder(encoding_name="cl100k_base", chunk_size=500, chunk_overlap=75, separators=["\n\n", "\n", ". ", " ", ""], add_start_index=True)`.
  - `cl100k_base` is the tokenizer OpenAI documents for text-embedding-3.
  - LLM **billing always comes from the API `usage`** and is never estimated with tiktoken.
- **Page mapping**: join a section's pages while recording the character offset where each page starts. The chunk's page range is `bisect_right(page_starts, start_index)` up to the page at `start_index + len(chunk)`. Store `page_start` and `page_end`.
- **Contextual header, embedded only**: embed `f"{doc_title} > {section_path}\n\n{content}"` but display `content`. This costs zero extra LLM calls. It's a cheap version of "contextual retrieval" and worth an eval ablation.
- **Why 500/75**: NVIDIA's five-dataset benchmark found 512–1024 tokens best for token-based splitting and 128 worst; page-level was the most consistent. The usual guidance is 10–20% overlap, and some 2026 analyses found no benefit from overlap at all. At 500 tokens, 6–8 chunks is about 3–4k context tokens. **Eval ablation**: 300/500/800 tokens vs page-level chunks.
- **Per-chunk metadata**: `id, document_id, user_id, chunk_index, content, section_path, page_start, page_end, char_start, token_count, content_hash, embedding_model, embedding, tsv (generated), created_at`.
- **Embedding reuse (a cost win)**: before calling OpenAI, run `SELECT content_hash, embedding FROM chunks WHERE user_id=$1 AND embedding_model=$2 AND content_hash = ANY($3)`. When a user uploads v2 of a policy, only the changed chunks are embedded. Log "embedding tokens saved". Send embeddings in batches of about 100–200 inputs per request **[per-request limits unverified]**.

---

## 5. Retrieval

**Hybrid search in one query.** Pass `doc_ids` explicitly (resolved to the user's `ready` documents) so the query plan stays simple. Use named psycopg parameters. `qvec` is a `HalfVector`.

```sql
-- run inside a transaction:
--   SET LOCAL hnsw.ef_search = 100;
--   SET LOCAL hnsw.iterative_scan = relaxed_order;
WITH semantic AS MATERIALIZED (
  SELECT id, embedding <=> %(qvec)s::halfvec(1536) AS dist
  FROM chunks
  WHERE user_id = %(user_id)s AND document_id = ANY(%(doc_ids)s::uuid[])
  ORDER BY embedding <=> %(qvec)s::halfvec(1536)
  LIMIT 40
),
sem AS (SELECT id, dist, row_number() OVER (ORDER BY dist) AS rnk FROM semantic),  -- re-sort after relaxed_order
kw AS (
  SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rnk
  FROM chunks c, websearch_to_tsquery('english', %(qtext)s) q
  WHERE c.user_id = %(user_id)s AND c.document_id = ANY(%(doc_ids)s::uuid[]) AND c.tsv @@ q
  ORDER BY ts_rank_cd(c.tsv, q) DESC
  LIMIT 40
)
SELECT c.id, c.document_id, c.content, c.section_path, c.page_start, c.page_end,
       1 - sem.dist AS cosine_sim,
       COALESCE(1.0 / (60 + sem.rnk), 0) + COALESCE(1.0 / (60 + kw.rnk), 0) AS rrf
FROM sem FULL OUTER JOIN kw ON kw.id = sem.id
JOIN chunks c ON c.id = COALESCE(sem.id, kw.id)
ORDER BY rrf DESC
LIMIT %(k)s;   -- k = 6..8
```

- **HNSW settings**: defaults `m=16, ef_construction=64` are fine below 1M vectors. `ef_search` defaults to 40; raise it to 100 with `SET LOCAL` for recall under filters.
- **Iterative scans** (pgvector ≥0.8; current release 0.8.6, 2026-07-29): `relaxed_order`, `hnsw.max_scan_tuples` default 20,000. They keep walking the index until the tenant filter is satisfied. With `relaxed_order` you must re-sort, which the `row_number()` above does. pgvector's docs use `ORDER BY distance + 0` on PG17+ for the same reason.
- **Talking point about scale**: at portfolio scale (under 50k chunks per user), the planner will often choose the `(user_id, document_id)` B-tree plus an exact distance sort, which gives 100% recall in a few milliseconds. HNSW with iterative scan matters once a tenant's slice grows. Show `EXPLAIN ANALYZE` for both cases. Defense in depth: Postgres RLS on `user_id` via `SET LOCAL app.user_id` (optional bonus).
- **FTS language**: Postgres has no built-in Slovak or Czech configuration. Use `'english'` for the MVP; for mixed-language documents, store a per-document `regconfig` or fall back to `'simple'`.
- **"I don't know"**:
  1. **Hard floor**: if the top `cosine_sim` is below τ_rel and there are no keyword hits, answer "not found in your documents" **without calling the LLM** (saves the whole generation cost).
  2. **Soft**: the prompt tells the model to abstain when the context is insufficient.
  - text-embedding-3 similarities are low in absolute terms (query-to-chunk typically 0.30–0.55; one study found τ≈0.40 optimal). **Start with τ_rel = 0.25–0.30** and calibrate on the eval set using deliberately unanswerable questions. Report abstention precision and recall.
- **Reranking**:

| Option | Extra RAM | Latency for 20 candidates | Cost | Languages |
|---|---|---|---|---|
| **Skip (default)** | 0 | 0 | 0 | any |
| FlashRank `ms-marco-TinyBERT-L-2-v2` (about 4 MB, the default) | about 100 MB RSS **[est.]** | tens of ms **[est.]** | 0 | EN |
| FlashRank `ms-marco-MiniLM-L-12-v2` (about 34 MB) | about 150–250 MB **[est.]** | about 100–200 ms on 2 vCPU **[est.; FlashRank quotes about 550 ms per 100 docs]** | 0 | EN |
| FlashRank `ms-marco-MultiBERT-L-12` (about 150 MB) | about 400 MB **[est.]** | slower | 0 | 100+ languages |
| LLM rerank with nano | 0 | +0.3–0.8 s | about +$0.0002 per query | any |

FlashRank uses onnxruntime and tokenizers, no torch. **Last release: 0.2.10, Jan 2025**, which is a maintenance risk. Sentence-transformers cross-encoders pull in torch, which is too heavy. **Plan**: weekend 1 without a reranker. Weekend 2: MiniLM behind `RERANK_ENABLED`, installed as an optional extra, and ablate "hybrid" vs "hybrid + rerank" in the eval. If the documents are Slovak, use MultiBERT or skip reranking.

---

## 6. Semantic cache in Postgres

```sql
CREATE TABLE semantic_cache (           -- Drizzle-owned
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope_hash text NOT NULL,             -- sha256(prompt_version|chat_model|sorted(doc_id:doc_content_sha256))
  question text NOT NULL,
  question_norm_hash text NOT NULL,     -- sha256(lower(collapse_ws(trim(q))))
  question_embedding halfvec(1536) NOT NULL,
  answer text NOT NULL,
  sources jsonb NOT NULL,               -- snapshot: chunk ids, doc title, pages, section
  original_cost_usd numeric(12,8) NOT NULL,  -- used to report "$ saved"
  hit_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_hit_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX ON semantic_cache (user_id, scope_hash);
CREATE UNIQUE INDEX ON semantic_cache (user_id, scope_hash, question_norm_hash);
-- no HNSW index: each (user, scope) slice is small, so an exact scan is fast and exact

-- Tier 1 (free, no false positives):
SELECT answer, sources FROM semantic_cache
 WHERE user_id=%(u)s AND scope_hash=%(s)s AND question_norm_hash=%(h)s AND expires_at > now();
-- Tier 2:
SELECT id, answer, sources, 1 - (question_embedding <=> %(qvec)s::halfvec(1536)) AS sim
  FROM semantic_cache
 WHERE user_id=%(u)s AND scope_hash=%(s)s AND expires_at > now()
 ORDER BY question_embedding <=> %(qvec)s::halfvec(1536) LIMIT 1;   -- accept if sim >= tau
```

- **Threshold**: start at **τ = 0.95**. Published studies use 0.8–0.92 for general-domain paraphrases, but policy questions often differ by a single entity ("sick leave for contractors" vs "for employees"), so start conservative. Tune it on a paraphrase and near-miss set from the eval and report the **false-hit rate** next to the hit rate.
- **Invalidation**: the scope hash includes each document's content hash, the prompt version and the model. Adding, replacing or deleting a document, or changing the prompt, therefore **automatically misses**; this is lazy invalidation. A nightly job run by the worker deletes expired rows. On document delete, optionally purge with `DELETE ... WHERE user_id=$1` for privacy.
- **Do not cache**: follow-up turns, unless they were first rewritten into a standalone question by a nano call that runs only when there is history (the rewritten question is then what gets embedded and cached); abstentions (or give them a short TTL); aborted streams; errors.
- **Tenant isolation**: `user_id` is part of every key, so one user's answers can never leak to another.

---

## 7. Streaming: FastAPI SSE → NestJS → React

**SSE event contract** (document it in `docs/sse-contract.md`):

| event | data |
|---|---|
| `meta` | `{requestId, model, cache: "miss" \| "exact" \| "semantic"}` |
| `sources` | `[{n, chunkId, documentId, title, pageStart, pageEnd, section, score, snippet}]`, sent **before** tokens so the UI can render `[n]` hovers while text streams |
| `token` | `{d: "..."}` |
| `done` | `{citedSources:[1,3], usage:{input, cached, output, reasoning, embedding}, costUsd, latencyMs:{retrieval, ttft, total}, abstained}` |
| `error` | `{code, message}` |

**Python side**: FastAPI **0.135+ has native SSE**. `fastapi.sse.EventSourceResponse` and `ServerSentEvent` send a keep-alive ping every 15 s and set `Cache-Control: no-cache` and `X-Accel-Buffering: no`, so `sse-starlette` is not needed.

```python
@router.post("/internal/chat", response_class=EventSourceResponse)
async def chat(req: ChatRequest) -> AsyncIterable[ServerSentEvent]:
    # ... embed, cache lookup, retrieve, maybe short-circuit ...
    yield ServerSentEvent(event="sources", data=sources)
    stream = await oai.responses.create(
        model=settings.chat_model, instructions=SYSTEM_PROMPT,  # static prefix
        input=[*history, {"role": "user", "content": render_context(chunks, req.question)}],
        reasoning={"effort": settings.reasoning_effort},   # "minimal" for gpt-5-nano, "none" for gpt-6-luna
        max_output_tokens=1000,  # reasoning tokens count against this, so don't set it too low
        store=False, stream=True, prompt_cache_key=f"chat:{req.chat_id}")
    try:
        async for ev in stream:
            if ev.type == "response.output_text.delta":
                yield ServerSentEvent(event="token", data={"d": ev.delta})
            elif ev.type == "response.completed":
                usage = ev.response.usage  # includes cached_tokens and reasoning_tokens
    finally:
        await write_query_log(...)  # still runs on client disconnect, so partial usage is recorded
    yield ServerSentEvent(event="done", data=build_done(usage, ...))
```

- Message order is: system prompt, then prior turns, then **context and question last**. OpenAI prompt caching applies to identical prefixes of **≥1024 tokens**, with cached input billed at 0.1× on GPT-5.6+. So caching only pays off from turn 2 onward, once chat history makes up the long prefix. Track `cached_tokens`.
- `store=False` keeps enterprise documents out of OpenAI's response storage.

**NestJS**: use a raw `@Post()` with `@Res()`. `@Sse()` is GET- and Observable-only.

```ts
const ac = new AbortController();
res.on('close', () => ac.abort());   // client left → abort upstream → Python stops the OpenAI stream (saves tokens)
const up = await fetch(`${AI_URL}/internal/chat`, { method: 'POST', signal: ac.signal,
  headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
  body: JSON.stringify({ userId: user.sub, chatId, question, documentIds }) });
res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }).flushHeaders();
const [toClient, toPersist] = up.body!.tee();
void this.persistOnDone(toPersist, user.sub, chatId);  // EventSourceParserStream; save assistant msg + citations + usage on 'done'
for await (const chunk of toClient) res.write(chunk);
res.end();
```

Python stays stateless about chats: it writes only `chunks`, `semantic_cache`, `query_logs` and job status. NestJS owns chats and messages.

**React**: use `fetch` with `Authorization: Bearer …`, then `res.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())` from `eventsource-parser/stream` (v4.1.1). Read it in a `getReader()` loop, which is safer on Safari than `for await`. Avoid `@microsoft/fetch-event-source`: its last publish was in 2021.

If Caddy or nginx sits in front, make sure it doesn't buffer. The `X-Accel-Buffering: no` header covers nginx; confirm that Caddy flushes `text/event-stream` responses **[verify in the infra config]**.

---

## 8. Ingestion jobs on a single EC2 instance

| Option | Verdict |
|---|---|
| FastAPI `BackgroundTasks` | Jobs are lost on restart or deploy, there are no retries or visibility, and CPU-bound parsing runs on the chat event loop. **No.** |
| **Postgres queue (SKIP LOCKED + LISTEN/NOTIFY)** | **Yes.** It's transactional with the `documents` insert (outbox pattern) and needs no extra infrastructure. |
| SQS + DLQ | Right choice with multiple instances. Mention it as the upgrade path behind a `JobSource` interface. |
| procrastinate 3.10 / pgqueuer 1.4 | Solid libraries, but both **install their own tables and migrations**, which conflicts with Drizzle owning the schema. The hand-rolled version is about 80 lines. |

```sql
CREATE TABLE ingestion_jobs (  -- Drizzle-owned
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  stage text,  -- downloading|parsing|chunking|embedding|indexing
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz, locked_by text, last_error text, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_active_job_per_doc ON ingestion_jobs(document_id) WHERE status IN ('queued','running');
CREATE INDEX ON ingestion_jobs (run_after) WHERE status = 'queued';

-- NestJS, in the same transaction as the document insert (NOTIFY is delivered on commit):
--   INSERT INTO ingestion_jobs ...; SELECT pg_notify('ingestion_jobs', <job id>);

-- Worker claim:
UPDATE ingestion_jobs j SET status='running', attempts=j.attempts+1, locked_at=now(), locked_by=%(w)s, updated_at=now()
WHERE j.id = (SELECT id FROM ingestion_jobs
              WHERE (status='queued' AND run_after <= now())
                 OR (status='running' AND locked_at < now() - interval '15 minutes')  -- lease recovery
              ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING j.id, j.document_id, j.attempts, j.max_attempts;
```

- **Worker**: a separate `ai-worker` container built from the same image (`python -m app.ingest.worker`). Parsing with pypdf is CPU- and GIL-bound, so isolating it keeps chat streaming responsive. It runs `LISTEN ingestion_jobs` on an autocommit connection and waits with `conn.notifies(timeout=10, stop_after=1)` **[psycopg ≥3.2 API]**, which also gives a polling fallback. After a wake-up it claims jobs until none are left. Blocking boto3 and pypdf calls go through `asyncio.to_thread`.
- **Heartbeat**: update `locked_at` and `stage` at each stage, so a long job isn't reclaimed as stale.
- **Retries**: non-retryable errors (`NO_TEXT_LAYER`, `ENCRYPTED`, `TOO_LARGE`) fail immediately. Anything else goes back to `queued` with `run_after = now() + 30s * 2^attempts` until `max_attempts`. The OpenAI SDK already retries twice internally.
- **Idempotency**:
  - The unique partial index prevents two active jobs for the same document.
  - The final write is **one transaction**: `DELETE FROM chunks WHERE document_id=$1`, `executemany INSERT`, `UPDATE documents SET status='ready', page_count, chunk_count, embed_tokens, embed_cost_usd`, `UPDATE job SET status='succeeded'`. Re-running a job is safe, and search never sees a half-ingested document.
  - The file's sha256 is stored on `documents` for per-user deduplication.
- **Status in the UI**: the frontend polls `GET /documents` every 2 s while any document is `processing`. This is simpler than SSE for status updates and is fine at this scale.

---

## 9. Versions (PyPI, 2026-09-25) and uv

| Package | Version | Note |
|---|---|---|
| Python | 3.14 (`python:3.14-slim`) | tiktoken ships cp314 aarch64 wheels. **Check the psycopg-binary and onnxruntime cp314 aarch64 wheels at `uv lock`**; fall back to 3.13 if either is missing. |
| fastapi | 0.141.1 | native SSE since 0.135.0 |
| uvicorn[standard] | 0.54.0 | |
| openai | 3.19.2 | released 2026-09-24; 3.x major |
| psycopg[binary,pool] / psycopg-pool | 3.3.6 / 3.3.3 | |
| pgvector (python) | 0.5.0 | extension 0.8.6 |
| pypdf | 6.19.0 | |
| langchain-text-splitters | 1.1.2 | pulls langchain-core 1.x |
| tiktoken | 0.14.0 | |
| pydantic / pydantic-settings | 2.13.5 / 2.15.0 | |
| boto3 | 1.43.103 | |
| flashrank (optional extra `rerank`) | 0.2.10 | last release Jan 2025 |
| uv | 0.12.19 | Docker image `ghcr.io/astral-sh/uv:0.12.19` |
| Not used, for reference | langchain 1.4.2, langchain-openai 1.6.6, langchain-postgres 0.0.18, llama-index-core 0.14.25, llama-index-vector-stores-postgres 0.9.0, pymupdf4llm 1.28.2, docling 2.130.0, unstructured 0.27.8, pypdfium2 5.13.0 | |
| DB image | `pgvector/pgvector:pg18` (or a versioned tag such as `0.8.6-pg18`) | **[tag format unverified; check Docker Hub]** |

**uv workflow**: `uv init --app`, then `uv add ...`, `uv lock` (commit `uv.lock`), `uv sync --locked`, `uv run pytest`. In `pyproject.toml`, use compatible ranges (for example `fastapi>=0.141,<0.142`) and treat `uv.lock` as the exact-pin source of truth. Put the reranker in `[project.optional-dependencies] rerank`, and pytest, ruff, mypy and testcontainers in `[dependency-groups] dev`.

```dockerfile
FROM python:3.14-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1 UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked

FROM python:3.14-slim
RUN useradd -r -u 10001 app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
# build: docker buildx build --platform linux/arm64 ...   (image ≈ 200–250 MB [est.])
```

**Layout**: `services/ai/app/{main.py, config.py, db.py, api/, rag/{retrieve,prompt,generate,cache,rerank}.py, ingest/{worker,parse_pdf,chunk,embed}.py, cost/pricing.py, repositories/}`, plus `tests/` and `eval/`.

---

## 10. Cost model, model choice and metrics to show

- **Per-query cost** = (input − cached) × p_in + cached × p_cached + output × p_out + embedding_tokens × p_emb. Output includes reasoning tokens.
  - Persist the **raw token counts** and a versioned price table (`cost/pricing.py` with `effective_from`), so costs can be recomputed when prices change.
- **Prices** (official OpenAI pages):

| Model | Input / cached / output per 1M tokens | Notes |
|---|---|---|
| `gpt-5-nano` | $0.05 / $0.005 / $0.40 | reasoning effort `minimal`, `low`, `medium` (default), `high` |
| `gpt-6-luna` | $0.10 / $0.01 / $0.50 | released **2026-09-23**; effort `none` up to `max`, default medium; 1.05M context |
| `gpt-5-mini` | $0.25 / $0.025 / $2.00 | |
| `text-embedding-3-small` | $0.02 | 1536 dims, normalized vectors, `dimensions` parameter available |

  - Skip GPT-5.6 Luna: at $0.20 / $1.20 it's now more expensive than GPT-6 Luna.
- **Worked example** (3,000 input and 350 output tokens):

| Case | Cost |
|---|---|
| gpt-5-nano | ≈ **$0.00029** per query |
| gpt-6-luna | ≈ $0.00048 per query |
| gpt-5-mini | ≈ $0.00145 per query |
| Semantic-cache hit | ≈ $0.0000006 (embedding only) |
| Ingesting a 200-page manual (about 100k tokens) | ≈ $0.002 |

  - **Always set the reasoning effort explicitly.** The default is `medium`, and reasoning tokens can multiply output cost several times.
- **Model choice**: default to `gpt-5-nano` with `minimal` effort as the cheapest option. Use `gpt-6-luna` with `none` as the challenger. Pick between them using the eval (quality vs $ per query). That comparison is a good interview story.
- **Metrics to put on the dashboard and in the README**:
  - $ per query (p50/p95) and $ saved by the cache
  - Cache hit rate (exact and semantic) and false-hit rate
  - Token breakdown: input, cached, output, reasoning
  - Retrieval hit@k and MRR on a golden set labeled with document and page
  - Faithfulness and citation accuracy (LLM judge on the eval set only)
  - Abstention precision and recall
  - Latency: TTFT, retrieval ms, total
  - Ingestion $ and pages per second
  - Ablations: vector vs hybrid vs hybrid + rerank; chunk size 300/500/800 vs page-level

**Unverified / check at build time**:
- psycopg-binary and onnxruntime cp314 aarch64 wheels
- pgvector Docker tag format
- OpenAI embeddings per-request limits
- tiktoken encoding for gpt-6-luna (irrelevant for billing, which comes from `usage`)
- All RAM and latency estimates for the reranker and the image size
- Caddy flushing behavior for SSE
- psycopg `notifies(timeout=, stop_after=)` signature (should be psycopg ≥3.2)

## Sources
- LangChain 1.0 GA and stability promise: https://www.langchain.com/blog/langchain-langgraph-1dot0 ; https://changelog.langchain.com/announcements/langchain-1-0-now-generally-available
- LangChain v1 changes (langchain-classic): https://docs.langchain.com/oss/python/releases/langchain-v1
- LangChain text splitters: https://docs.langchain.com/oss/python/integrations/splitters
- PGVectorStore (custom table, filter DSL): https://docs.langchain.com/oss/python/integrations/vectorstores/pgvectorstore ; https://github.com/langchain-ai/langchain-postgres
- LangChain usage metadata and streaming issues: https://reference.langchain.com/python/langchain-core/callbacks/usage/get_usage_metadata_callback ; https://reference.langchain.com/python/langchain-openai/chat_models/base/BaseChatOpenAI/stream_usage ; https://github.com/langchain-ai/langchain/issues/30390 ; https://github.com/langchain-ai/langchain/issues/33717
- LlamaIndex PGVectorStore source (`data_` table): https://github.com/run-llama/llama_index/blob/main/llama-index-integrations/vector_stores/llama-index-vector-stores-postgres/llama_index/vector_stores/postgres/base.py ; 0.14.0 release: https://github.com/run-llama/llama_index/releases/tag/v0.14.0
- PyPI JSON (versions and dependencies): https://pypi.org/pypi/langchain/json , https://pypi.org/pypi/langchain-core/json , https://pypi.org/pypi/langchain-text-splitters/json , https://pypi.org/pypi/langchain-openai/json , https://pypi.org/pypi/langchain-postgres/json , https://pypi.org/pypi/llama-index-core/json , https://pypi.org/pypi/llama-index-vector-stores-postgres/json , https://pypi.org/pypi/openai/json , https://pypi.org/pypi/fastapi/json , https://pypi.org/pypi/uvicorn/json , https://pypi.org/pypi/psycopg/json , https://pypi.org/pypi/psycopg-pool/json , https://pypi.org/pypi/pgvector/json , https://pypi.org/pypi/tiktoken/0.14.0/json , https://pypi.org/pypi/pypdf/json , https://pypi.org/pypi/pypdfium2/json , https://pypi.org/pypi/pymupdf/json , https://pypi.org/pypi/pymupdf4llm/json , https://pypi.org/pypi/pymupdf-layout/json , https://pypi.org/pypi/docling/json , https://pypi.org/pypi/docling-slim/json , https://pypi.org/pypi/unstructured/json , https://pypi.org/pypi/flashrank/json , https://pypi.org/pypi/procrastinate/json , https://pypi.org/pypi/pgqueuer/json , https://pypi.org/pypi/sse-starlette/json , https://pypi.org/pypi/boto3/json , https://pypi.org/pypi/pydantic/json , https://pypi.org/pypi/pydantic-settings/json , https://pypi.org/pypi/uv/json
- OpenAI SDK releases (3.19.2): https://github.com/openai/openai-python/releases
- OpenAI pricing and models: https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/models ; https://developers.openai.com/api/docs/models/gpt-5-nano ; https://developers.openai.com/api/docs/models/gpt-6-luna ; https://venturebeat.com/technology/openai-releases-gpt-6-sol-and-luna-models-slashing-api-costs-50-or-more ; https://thenewstack.io/openai-gpt-6-sol-luna-release/ ; https://www.cloudzero.com/blog/openai-pricing/
- OpenAI reasoning, prompt caching, streaming, embeddings: https://developers.openai.com/api/docs/guides/reasoning ; https://community.openai.com/t/gpt-5-nano-accepted-parameters/1355086 ; https://developers.openai.com/api/docs/guides/prompt-caching ; https://developers.openai.com/api/docs/guides/streaming-responses ; https://developers.openai.com/api/docs/guides/embeddings
- pgvector README and changelog: https://github.com/pgvector/pgvector ; https://raw.githubusercontent.com/pgvector/pgvector/master/CHANGELOG.md ; https://www.thenile.dev/blog/pgvector-080 ; https://www.crunchydata.com/blog/hybrid-vector-search
- pgvector-python and RRF example: https://github.com/pgvector/pgvector-python ; https://github.com/pgvector/pgvector-python/blob/master/examples/hybrid_search/rrf.py
- Drizzle: https://orm.drizzle.team/docs/extensions/pg ; https://orm.drizzle.team/docs/guides/vector-similarity-search ; https://orm.drizzle.team/docs/indexes-constraints ; https://orm.drizzle.team/docs/generated-columns ; https://orm.drizzle.team/docs/guides/postgresql-full-text-search ; https://orm.drizzle.team/docs/kit-custom-migrations ; https://registry.npmjs.org/drizzle-orm/latest ; https://registry.npmjs.org/drizzle-kit/latest
- Postgres FTS configurations: https://www.postgresql.org/docs/current/textsearch.html
- pypdf: https://pypdf.readthedocs.io/en/stable/user/extract-text.html ; https://pypdf.readthedocs.io/en/latest/user/handling-outlines.html
- Chunking benchmarks: https://www.firecrawl.dev/blog/best-chunking-strategies-rag ; https://www.premai.io/blog/rag-chunking-strategies-the-2026-benchmark-guide/
- Similarity thresholds and semantic cache: https://arxiv.org/html/2603.03301v1 ; https://arxiv.org/html/2411.05276v2 ; https://www.s-anand.net/blog/embeddings-similarity-threshold/ ; https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670
- FlashRank: https://github.com/PrithivirajDamodaran/FlashRank
- FastAPI native SSE: https://fastapi.tiangolo.com/tutorial/server-sent-events/
- eventsource-parser and fetch-event-source: https://registry.npmjs.org/eventsource-parser/latest ; https://registry.npmjs.org/@microsoft/fetch-event-source
- uv Docker guide: https://docs.astral.sh/uv/guides/integration/docker/
