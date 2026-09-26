# SmartDoc AI: research on quality monitoring, evaluation and observability

## 0. Decisions in brief

- **Traces:** use **Langfuse Cloud Hobby in the EU region**. Instrument through OpenTelemetry (OTel): Langfuse Python SDK v4 in FastAPI, and `@langfuse/otel` v5 in NestJS. Don't self-host Langfuse v3. It needs at least 4 vCPU and 16 GiB RAM, about 4× a t4g.medium app box. Arize Phoenix (one container, can reuse your Postgres) is the fallback.
- **Your own Postgres is the source of truth for money, quality aggregates and enforcement.** It holds `llm_calls`, `rag_requests`, `retrievals`, `feedback`, `quality_checks`, `model_prices` (versioned), `user_daily_usage` and `cost_savings`. Langfuse is only for debugging individual traces. Every row carries a `trace_id` so the dashboard can deep-link to the trace.
- **Offline eval:** a Python harness in `eval/` that imports the AI service's retrieval and generation code in-process.
  - Deterministic retrieval metrics, no LLM needed: Hit@k, Recall@k, MRR, refusal accuracy, citation validity.
  - RAGAS 0.4.3 `ragas.metrics.collections` for the LLM-judged metrics: Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall.
  - A JSONL golden set in the repo, `make eval` / `make eval-sweep` / `make eval-report`, and a README table generated between markers.
  - **promptfoo only for red-teaming indirect prompt injection** (stretch goal). Keep **DeepEval** as the fallback if RAGAS breaks.
- **Model facts that change the design:**
  - **gpt-4.1-nano shuts down on 2026-10-23, and gpt-5-nano and gpt-5-mini on 2026-12-11.**
  - **gpt-6-luna** launched on 2026-09-23 at $0.10 input / $0.01 cached / $0.125 cache-write / $0.50 output per 1M tokens.
  - GPT-5.6+ models **charge cache writes at 1.25× input**, so prompt caching can have **negative** net savings. Account for it.

---

## 1. Tracing

### 1.1 Options (verified 2026-09-25)

| Option | Limits / footprint | Fit |
|---|---|---|
| **Langfuse Cloud Hobby** | 50k units/month, 30-day data access, 2 users, unlimited projects. A unit is any trace, observation (span, event, generation) or score. Core plan: $29/month for 100k units, 90 days. The EU region is AWS eu-west-1 (Ireland), with backups copied to eu-central-1. | **Chosen.** No infrastructure to run. OTLP endpoint at `https://cloud.langfuse.com/api/public/otel` (HTTP/JSON or protobuf, no gRPC). Supports scores via API, masking hooks, and ingested cost. |
| Langfuse self-host v3 | Postgres + ClickHouse + Redis/Valkey + S3/MinIO + web + worker. Docker Compose needs **"at least 4 cores and 16 GiB of memory, e.g. a t3.xlarge"** and 100 GiB of disk. Langfuse says Compose is not for production (no HA, scaling or backups). | **Rejected.** A t3.xlarge is about $0.166/h in the US (~$121/month), more in Frankfurt (regional price not verified). That dwarfs a 2 vCPU / 4 GiB t4g.medium app box. |
| LangSmith Developer | 5k base traces/month, 14-day retention, 1 seat, then pay-as-you-go (the per-1k rate isn't published on the pricing page). Plus is $39/seat/month. | Viable, but closed source and centred on LangChain. Billed per trace rather than per observation, so the headroom is similar to Langfuse. |
| Arize Phoenix self-host | One container (`arizephoenix/phoenix`), version 20.16.0 (2026-09-23), **Elastic License 2.0**. Uses SQLite by default, or Postgres via `PHOENIX_SQL_DATABASE_URL`, with an optional separate schema. UI on port 6006, OTLP gRPC on 4317. Supports OAuth2, LDAP and local auth. | **Fallback.** It fits on the same EC2 and can share your Postgres in its own schema. A third party says 512 MB of RAM is too little for large queries (not verified). It costs RAM on a small box. |
| Own `llm_calls` table only | Zero cost | Needed anyway for cost and budget. It gives no span waterfall or prompt/response inspection UI. |

**OTel GenAI semantic conventions status.** The attributes `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, `reasoning.output_tokens`, `gen_ai.request.model` and `gen_ai.response.model` are now marked *Deprecated/moved* in the core registry. They moved to `open-telemetry/semantic-conventions-genai`, which has **no release yet**. `gen_ai.operation.name` and `gen_ai.provider.name` are at *Development* stability. Langfuse maps `gen_ai.usage.*` and the model attributes, and accepts `gen_ai.usage.cost`.

What this means in practice: emit the attributes, but let the Langfuse SDK and integrations do the mapping. Don't build dashboards on raw OTel attribute names; build them on your own Postgres columns.

### 1.2 What goes where

| Concern | Langfuse (traces) | Own Postgres |
|---|---|---|
| "Why was this answer wrong?": prompt, retrieved chunks, span timing | yes | only aggregates plus `trace_id` |
| Cost per user/day, **budget enforcement** (synchronous, transactional) | no (ingestion lag, third-party dependency) | **yes** |
| In-app dashboard, retention beyond 30 days, per-user scoping by Cognito `sub` | no | **yes** |
| Feedback and groundedness scores | mirrored as scores | **source of truth** |
| Eval results | optional | JSON files in the repo (the README reads them) plus an optional `eval_runs` table |

Why this split holds up in an interview: *traces are for debugging, the ledger is for money*. A SaaS outage or free-tier exhaustion must never stop budget enforcement or erase cost history.

### 1.3 Instrumentation design

- **Python (FastAPI):** `langfuse` 4.15.6 (2026-09-24, Python ≥3.10). Instrument through the framework you choose:
  - LangChain: `from langfuse.langchain import CallbackHandler`, with `langfuse_user_id` and `langfuse_session_id` passed in metadata.
  - LlamaIndex: `openinference-instrumentation-llama-index` → `LlamaIndexInstrumentor().instrument()`.
- **NestJS:** `@langfuse/otel` `LangfuseSpanProcessor` inside `NodeSDK({ spanProcessors: [...] })`, plus `@langfuse/tracing` for the root observation `chat.request`.
  - Python v4 and JS v5 **drop non-LLM spans (HTTP, DB) by default**. Export only happens for Langfuse-created spans, spans with `gen_ai.*` attributes, or known LLM scopes. That keeps free-tier units focused. Override with `shouldExportSpan` / `should_export_span`.
- **Cross-service trace:** NestJS creates the root span and sends `traceparent` (or `x-trace-id` plus the parent span id) to FastAPI.
  - Python joins the trace with `start_as_current_observation(trace_context={"trace_id": ..., "parent_span_id": ...})`.
  - Don't rely on FastAPI auto-instrumentation for the parent link. Its server span is filtered out by default, which can orphan children. This is my inference from the filter behaviour, not tested.
  - There is an open issue about phantom parent observations with `trace_context` in the v4 preview UI. Test this early.
- **Span tree per chat turn** (~6–8 units): `chat.request` → `cache.lookup` → `embed.query` (generation) → `retrieve` (attributes: top_k, hybrid, scores) → `rerank` (optional) → `llm.generate` (generation) → scores (`user_feedback`, `groundedness`). That gives roughly **6k chat turns/month in 50k units**. Disable export during eval sweeps (the SDK tracing-enabled/sample-rate env flags exist in the SDK, but I didn't re-check the exact names).
- **Cost in Langfuse:** send `cost_details` computed from your own `model_prices`. Ingested values take priority over inferred ones. That keeps one source of pricing truth, and it matters because gpt-6-luna is 2 days old and may be missing from Langfuse's built-in price list (not verified).
- **Privacy ("enterprise" framing):** mask with Python `mask_otel_spans` or JS `LangfuseSpanProcessor({ mask })` before export. Document that chunk text is sent to Langfuse EU, with the option to redact.
- **Logs:** structured JSON (nestjs-pino / structlog) with `request_id` and `trace_id` on every line.

---

## 2. Offline evaluation

### 2.1 Tool status

- **RAGAS:** the latest PyPI release is **0.4.3 (2026-01-13)**, and nothing newer has been published in about 8 months. `main` is at 0.4.4.dev8, and the repo now lives at `vibrantlabsai/ragas`.
  - The current API is `from ragas.metrics.collections import Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall, ContextUtilization`, with `llm_factory("model", client=AsyncOpenAI())` and `await scorer.ascore(...)`.
  - **Faithfulness** = supported claims / total claims (extract claims, then verify each). Inputs: `user_input`, `response`, `retrieved_contexts`.
  - **AnswerRelevancy** generates N=3 questions (the `strictness` parameter) from the answer and takes the mean cosine similarity to the user question. It needs embeddings.
  - **ContextPrecision** needs `reference`. **ContextUtilization** is the variant without a reference and uses `response`.
  - **ContextRecall**: `user_input`, `retrieved_contexts`, `reference`.
  - **Free deterministic variants:** `IDBasedContextPrecision` and `IDBasedContextRecall` (`retrieved_context_ids` vs `reference_context_ids`), and `NonLLMContextRecall` / `NonLLMContextPrecisionWithReference` (string distance).
  - **Testset generation:** `TestsetGenerator(llm, embedding_model).generate_with_langchain_docs(docs, testset_size=N)`, or `generate_with_llama_index_docs`. It builds a knowledge graph first. Default mix: 50% SingleHopSpecific, 25% MultiHopAbstract, 25% MultiHopSpecific. RAGAS publishes no cost figures.
  - **Risk:** RAGAS's `llm_factory` has had parameter-mapping bugs with reasoning models (`max_tokens` vs `max_completion_tokens`, temperature, top_p), and a GPT-6 issue was opened 2026-09-24 (for Bedrock IDs). Plan a **30-minute spike** running Faithfulness with gpt-6-luna on 0.4.3. Fallbacks, in order: pin `main` to a commit SHA; use `gpt-4o-mini` as judge (not deprecated, non-reasoning, accepts temperature 0); switch to DeepEval.
- **DeepEval 4.2.6 (2026-09-24):** actively released. Has AnswerRelevancy, Faithfulness, ContextualPrecision/Recall/Relevancy, and runs under pytest via `deepeval test run`. The best fallback.
- **promptfoo 0.123.1** (npm, published ~6 days ago, needs Node ≥22.22). OpenAI announced it would acquire promptfoo on 2026-03-09; it stays MIT and open source. It has YAML configs, HTTP and `file://*.py` providers, and the assertions `context-faithfulness`, `context-recall`, `context-relevance`, `answer-relevance`, `factuality` and `llm-rubric`, with `contextTransform` to pull context out of the response. **The red-team plugin `indirect-prompt-injection` (with `indirectInjectionVar: context`) is the part worth using here.**

**Why the harness is Python-first, even though you are a TS developer:** the AI service is Python, and running it in-process lets the harness swap config (chunk profile, top_k, hybrid, model) without HTTP, auth or deployment. The retrieval metrics need custom code in any tool. RAGAS metric names are what interviewers recognise.

### 2.2 Harness layout

```
eval/
  corpus/                    # public PDFs used for eval (license noted per file)
  datasets/golden_v1.jsonl   # human-verified; versioned by filename
  datasets/cache_pairs_v1.jsonl  # paraphrase + near-miss pairs for semantic-cache threshold
  configs/baseline.yaml  configs/sweep.yaml  thresholds.yaml
  run_eval.py  metrics.py  judge.py  report.py
  results/<date>_<gitsha>_<confighash>.json   # committed; README table is generated from these
```

**Golden record (JSONL).** Anchor ground truth to **(doc, page, evidence quote)**, not to chunk IDs. Chunk IDs change whenever the chunk size changes.

```json
{"id":"hr-017","type":"single_hop","answerable":true,
 "question":"How many days of paid leave do new employees get?",
 "reference_answer":"25 working days per year, pro-rated in the first year.",
 "evidence":[{"doc":"employee-handbook.pdf","page":12,"quote":"25 working days of paid annual leave"}],
 "owner":"alice","tags":["hr","numeric"],"source":"ragas-synthetic","reviewed":true}
```

**Composition (~60 questions):**

| Type | Count | What it tests |
|---|---|---|
| single_hop | 25 | basic retrieval and answering |
| multi_hop | 10 | combining evidence from several chunks |
| unanswerable | 10 | answer not in the corpus → must refuse |
| cross_tenant | 5 | question about another user's document → must refuse |
| injection | 5 | target document contains planted instructions |
| follow_up | 5 | conversational follow-ups |

Generate about 50 candidates with RAGAS, then keep about 35 after manual review and fix the reference answers. Label them "human-verified synthetic" in the README. Write the adversarial types by hand.

**Metrics, in two tiers:**

1. **Deterministic, no LLM, runs in CI on every PR:**
   - Hit@k, Recall@k (evidence items covered: same doc and page overlap or fuzzy quote match), MRR.
   - Refusal accuracy on unanswerable and cross-tenant questions; false-refusal rate on answerable ones.
   - Citation validity (every `[n]` points to a provided chunk); citation coverage.
   - Injection success rate (planted canary string appears in the output).
   - Tokens, cost per query, latency.
2. **LLM judge (manual, nightly, or PR label `run-eval`):** RAGAS Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall.

**Judge policy.** Use gpt-6-luna as the sweep judge with low reasoning effort (reasoning tokens bill as output). **Calibrate it:** hand-label 30 answers as faithful or not, then report judge–human agreement or Cohen's κ. Optionally re-score 20 samples with a stronger model (gpt-6-sol) to check. This is the single most credible quality claim you can make.

**Config sweep.** Change one factor at a time from the baseline, then run the best combination:

| Factor | Values |
|---|---|
| Chunk size (15% overlap) | 300 / 500 / 800 tokens → **each needs its own index profile** (a `chunks.index_profile` column; ingest the eval corpus once per profile) |
| top_k | 3 / 5 / 8 |
| Hybrid (pgvector + Postgres FTS, fused with RRF) | off / on |
| Reranker | off / on |
| Model | gpt-6-luna / gpt-5.4-nano / gpt-5.4-mini |
| Semantic-cache threshold | swept on `cache_pairs_v1`: plot hit rate vs **wrong-hit rate** (e.g. near-miss pairs like "vacation days for interns" vs "…for employees") |

That is about 12 runs.

**Statistics.** With n≈60, a 95% CI on a proportion near 0.85 is about ±9–10 pp. Use a **paired bootstrap over question IDs** for deltas between configs. Claim an improvement only when the CI excludes 0. Repeat the final 2–3 configs 3× because reasoning models aren't deterministic.

**CI (GitHub Actions).**
- On PRs touching `ai-service/**` or `eval/**`: docker-compose Postgres, ingest the corpus (~100k tokens ≈ $0.002 of embeddings), run the tier-1 metrics.
- Fail if a metric is below `thresholds.yaml` (e.g. `recall@5>=0.85`, `refusal_acc>=0.9`, `citation_validity==1.0`, `cost_per_query<=0.001`), or if it drops more than a tolerance vs `results/main.json`. Don't gate on latency; CI runners are too noisy.
- Use a **dedicated OpenAI project with a hard spend limit** for CI keys.

**README publishing.** `make eval-report` writes a Markdown table between `<!-- EVAL:START -->` and `<!-- EVAL:END -->` and saves a quality-vs-cost Pareto PNG (matplotlib) to `docs/`. Each row carries the git SHA, dataset version and config hash. Columns:

`Config | Recall@5 | MRR | Faithfulness | AnswerRel | Refusal acc | Injection success | $/query | p95 ms | n`

### 2.3 Eval cost (my estimate, not verified)

Per sample with k=5: Faithfulness 2 calls, AnswerRelevancy 1 call plus embeddings, ContextPrecision ~k calls, ContextRecall 1 call. That is about 13–14k input and 2–3k output tokens.

- **50 samples, gpt-6-luna judge:** about 0.7M input and 0.15M output tokens ≈ **$0.15/run**. Generating the answers adds about $0.02.
- **12-config sweep:** about **$2–3**.
- **The same sweep with a gpt-6-sol judge:** about $3/run, $35+ for the sweep. Use Sol only for the calibration subset.
- **RAGAS testset generation over ~100 pages with luna:** roughly $0.1–0.5 (not verified).

---

## 3. Online quality signals

| Signal | How it's computed | Stored in | Use / alert |
|---|---|---|---|
| Thumbs up/down + comment | UI → NestJS; `rating ∈ {-1,1}`, reason tags (`wrong`, `incomplete`, `no_citation`, `irrelevant`), free text | `feedback`, mirrored to Langfuse `create_score(trace_id=…)` | thumbs-up rate, feedback rate; every thumbs-down gets a groundedness check |
| Retrieval scores | per chunk: vector, BM25, RRF and rerank scores; per request: top-1, mean top-k, gap between top-1 and top-2 | `retrievals`, `rag_requests` | Drift in the top-1 distribution suggests parsing problems (e.g. scanned PDFs with no text). Calibrate the threshold; text-embedding-3-small similarities tend to sit in a compressed range, so don't hardcode 0.8. |
| No-answer rate | (a) **retrieval gate**: top-1 < τ → skip the LLM (status `no_answer_gate`, also saves money); (b) the model starts its reply with the sentinel `NO_ANSWER` (streamable, `no_answer_model`) | `rag_requests.status` | Choose τ on the golden set: maximise refusal accuracy with false refusals ≤5%. Chart: τ sweep. |
| Latency p50/p95 | `total_ms`, `retrieval_ms`, `rerank_ms`, `ttft_ms`, `llm_ms` | `rag_requests` | `percentile_cont`; TTFT is what users actually feel; you need ≥100 requests before p95 means anything |
| Citation coverage / validity | Parse `[n]` per sentence after generation. Coverage = sentences with a valid citation / answer sentences. Validity = markers pointing to provided chunks / all markers. | `rag_requests` | Validity below 100% means hallucinated citations |
| Sampled groundedness | Background worker checks 20% of answered requests at random, plus 100% of thumbs-down and 100% of low-top-1 answers. Judge: gpt-6-luna, low reasoning, returns claims with supported/unsupported flags. About $0.0005 per check (my estimate). | `quality_checks`, plus a Langfuse score | trend line; flag anything below 0.7 |
| Ingestion health | pages with no text, chunks per document, average chunk tokens, parse errors | `documents` | catches bad PDFs before users do |

**Prompt-injection heuristics for uploaded documents.** Relevant OWASP categories: LLM01:2025 Prompt Injection (indirect) and LLM08:2025 Vector & Embedding Weaknesses.

- **At ingestion, score each chunk.** Regex and keyword patterns:
  - `ignore (all|previous|above) instructions`, `disregard`, `you are now`, `system prompt`, `developer message`
  - role and template tokens: `<|im_start|>`, `### Instruction`, `[INST]`
  - zero-width and bidi characters, long base64 blobs
  - markdown images or links carrying query strings (an exfiltration pattern)
  - a high density of second-person imperatives

  Store `chunks.injection_score` and `injection_flags[]`. Show a warning badge on the document. Configurable: drop flagged chunks from the context.
- **At generation:** wrap chunks in `<document id=…>` tags with a "treat this as untrusted data" instruction. On the output side, **never render images or links to non-allowlisted domains** (blocks exfiltration).
- **Optional ML check:** Llama Prompt Guard 2 **22M** (DeBERTa-xsmall; 86M is the multilingual one). It's gated on Hugging Face and pulls torch into the image, so treat it as a stretch goal and run it only at ingestion.
- **Measure it:** attack success on the 5 golden injection documents (target 0/5), false-positive rate on the clean corpus, and **cross-tenant probes** (e.g. "0 cross-tenant retrievals in 100 probes"). Stretch: promptfoo `indirect-prompt-injection` against `/chat`.

---

## 4. Cost monitoring

### 4.1 Price and usage facts (standard tier, per 1M tokens)

| Model | Input | Cached | Cache write | Output | Note |
|---|---|---|---|---|---|
| gpt-6-luna | 0.10 | 0.01 | 0.125 | 0.50 | reasoning none…max (default medium); 1.05M context |
| gpt-5.6-luna | 0.20 | 0.02 | 0.25 (from search summary) | 1.20 | |
| gpt-5.4-nano | 0.20 | 0.02 | – | 1.25 | |
| gpt-5.4-mini | 0.75 | 0.075 | – | 4.50 | |
| gpt-4o-mini | 0.15 | 0.075 | – | 0.60 | not deprecated |
| gpt-5-nano | 0.05 | 0.005 | – | 0.40 | **shutdown 2026-12-11** |
| gpt-4.1-nano | 0.10 | 0.025 | – | 0.40 | **shutdown 2026-10-23** |
| text-embedding-3-small | 0.02 | | | | |
| text-embedding-3-large | 0.13 | | | | |

- Batch and Flex are about −50%. **Data-residency endpoints add +10%** for models released on or after 2026-03-05.
- **Prompt caching on GPT-5.6+:**
  - on by default, minimum 1,024 visible input tokens, default TTL `30m`
  - automatic breakpoint at the latest eligible message, or explicit via `prompt_cache_breakpoint`
  - `prompt_cache_key` is optional and only affects cache accounting
  - cache writes cost 1.25× input, and "input tokens use the uncached-input, cached-input, or cache-write rate", i.e. the three rates partition input tokens
- **Usage fields:**
  - Responses API: `usage.input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`. Reasoning tokens are part of `output_tokens`.
  - Chat Completions: `prompt_tokens_details.cached_tokens`; when streaming you need `stream_options.include_usage` (usage arrives in the last chunk, and an interrupted stream may lose it).
  - Normalise both in one adapter.

**Cost formula.** Compute it once, in SQL, at insert time:

```
uncached_in = input_tokens - cached_tokens - cache_write_tokens   -- assert >= 0 on first real responses
cost_usd = (uncached_in*p_in + cached_tokens*p_cached + cache_write_tokens*p_cw + output_tokens*p_out)/1e6
         * tier_multiplier (batch 0.5) * region_multiplier (1.10 if data-residency & model >= 2026-03-05)
-- never add reasoning_tokens separately
```

**Prompt caching in RAG is often small, and can be negative.** The retrieved chunks change on every query, so only three things are reusable:
- a static system prompt plus few-shot examples, and only if they total ≥1,024 tokens
- the earlier turns of the same chat (use `prompt_cache_key = chat_id`)
- eval reruns

So report **net** savings: `cached*(p_in − p_cached) − cache_write*(p_cw − p_in)`.

### 4.2 Data model (Postgres DDL; mirror it in Drizzle)

```sql
create extension if not exists btree_gist;
create table model_prices (
  id serial primary key, provider text not null default 'openai', model text not null,
  effective_from timestamptz not null, effective_to timestamptz,
  input_usd_per_mtok numeric(12,6) not null, cached_input_usd_per_mtok numeric(12,6),
  cache_write_usd_per_mtok numeric(12,6), output_usd_per_mtok numeric(12,6),
  source_url text not null,
  exclude using gist (model with =, tstzrange(effective_from, effective_to) with &&));
create table model_aliases (response_model text primary key, model text not null); -- snapshot -> price key

create table rag_requests (
  id uuid primary key, user_id text not null, chat_id uuid, trace_id char(32),
  created_at timestamptz default now(), config jsonb not null, config_hash text not null,
  status text not null,          -- answered|no_answer_gate|no_answer_model|budget_blocked|error
  cache_type text not null default 'none',  -- none|exact|semantic
  top1_score real, mean_topk_score real, n_chunks int, n_citations int,
  citation_coverage real, citations_valid boolean, injection_flagged_chunks int default 0,
  total_ms int, retrieval_ms int, rerank_ms int, ttft_ms int, llm_ms int,
  cost_usd numeric(14,10) default 0, baseline_cost_usd numeric(14,10));

create table llm_calls (
  id bigserial primary key, request_id uuid references rag_requests, document_id uuid,
  user_id text not null, purpose text not null, -- chat|query_embed|doc_embed|rerank|judge|eval
  model text not null, price_id int references model_prices, openai_response_id text unique,
  input_tokens int not null default 0, cached_tokens int not null default 0,
  cache_write_tokens int not null default 0, output_tokens int not null default 0,
  reasoning_tokens int not null default 0, cost_usd numeric(14,10) not null,
  latency_ms int, created_at timestamptz default now());

create table retrievals (request_id uuid, rank smallint, chunk_id uuid, document_id uuid,
  vector_score real, bm25_score real, rrf_score real, rerank_score real, cited boolean,
  primary key (request_id, rank));
create table feedback (request_id uuid primary key, user_id text, rating smallint,
  reasons text[], comment text, created_at timestamptz default now());
create table quality_checks (id bigserial primary key, request_id uuid, check_type text,
  judge_model text, score real, details jsonb, sample_reason text, cost_usd numeric(14,10),
  created_at timestamptz default now());
create table user_budgets (user_id text primary key, daily_limit_usd numeric(10,4) not null default 0.25);
create table user_daily_usage (user_id text, day date, spent_usd numeric(14,10) default 0,
  reserved_usd numeric(14,10) default 0, requests int default 0, primary key (user_id, day));
create table cost_savings (id bigserial primary key, request_id uuid, mechanism text,
  -- semantic_cache|exact_cache|prompt_cache|no_answer_gate|context_trim|model_routing|embedding_dedup
  baseline_usd numeric(14,10), actual_usd numeric(14,10), saved_usd numeric(14,10),
  created_at timestamptz default now());
```

**Who writes what.** The service that makes the OpenAI call (Python) inserts into `llm_calls` in a `finally` block, so usage is recorded even when the client disconnects mid-stream. The insert is idempotent on `openai_response_id`, and cost is computed inside the INSERT with a join to `model_prices`. An `AFTER INSERT` trigger on `llm_calls` adds `cost_usd` to `user_daily_usage.spent_usd`, so the ledger can't drift from the usage rows. NestJS owns `rag_requests`, the budget and the user.

**Budget enforcement** (atomic, no explicit lock):

```sql
insert into user_daily_usage(user_id, day) values ($1, (now() at time zone 'Europe/Bratislava')::date)
  on conflict do nothing;
update user_daily_usage u set reserved_usd = reserved_usd + $2   -- $2 = est. max cost (max_output_tokens*p_out + est_in*p_in)
 where u.user_id = $1 and u.day = (now() at time zone 'Europe/Bratislava')::date
   and u.spent_usd + u.reserved_usd + $2 <= (select daily_limit_usd from user_budgets where user_id = $1)
returning spent_usd, reserved_usd;       -- 0 rows => HTTP 429 + Retry-After (local midnight)
-- after completion: update ... set reserved_usd = reserved_usd - $2, requests = requests + 1
```

Layer it: per-user daily limit, then a global daily app cap, then an OpenAI **project hard spend limit**. The last one returns 429 `project_spend_limit_exceeded`, resets monthly, and "is not instantaneous". Also cap `max_output_tokens` and question length, and add `@nestjs/throttler`.

**Savings attribution.** These are counterfactual estimates; label them "estimated".

| Mechanism | How it's computed |
|---|---|
| Semantic or exact cache | baseline = `original_cost_usd` stored on the cache entry; actual = query-embedding cost |
| Prompt cache | the net formula in 4.1 (can be negative) |
| No-answer gate | baseline = rolling 7-day median generation cost of answered requests |
| Context trim / rerank | (tokens before trim − after) × p_in − reranker cost |
| Model routing | same tokens × default-model price − actual |
| Embedding dedup | skipped tokens × p_embed |

**Check the estimates with an A/B replay:** run the same traffic with optimisations off and then on, and compare real billed cost. Optionally reconcile daily against the OpenAI **Costs API** (`GET /organization/costs`, Admin key, `bucket_width=1d`, `group_by=project_id,line_item`).

### 4.3 Dashboard SQL

```sql
-- KPIs + cost/day
select date_trunc('day', created_at) d, count(*) requests, sum(cost_usd) cost,
       sum(cost_usd)/nullif(count(*),0) cost_per_query,
       avg((cache_type<>'none')::int) cache_hit_rate,
       avg((status like 'no_answer%')::int) no_answer_rate,
       sum(baseline_cost_usd - cost_usd) est_saved
from rag_requests where created_at >= now() - interval '30 days' group by 1 order by 1;

-- latency percentiles (FILTER works with ordered-set aggregates)
select percentile_cont(0.5) within group (order by total_ms) p50,
       percentile_cont(0.95) within group (order by total_ms) p95,
       percentile_cont(0.95) within group (order by ttft_ms) filter (where cache_type='none') ttft_p95_uncached
from rag_requests where created_at >= now() - interval '7 days';

-- token mix / prompt-cache ratio by purpose+model
select purpose, model, sum(input_tokens-cached_tokens-cache_write_tokens) uncached_in,
       sum(cached_tokens) cached_in, sum(cache_write_tokens) cache_write,
       sum(output_tokens-reasoning_tokens) visible_out, sum(reasoning_tokens) reasoning_out,
       sum(cached_tokens)::float/nullif(sum(input_tokens),0) prompt_cache_ratio, sum(cost_usd) cost
from llm_calls where created_at >= current_date - 7 group by 1,2 order by cost desc;

-- savings waterfall
select mechanism, count(*) n, sum(saved_usd) saved, sum(saved_usd)/sum(sum(saved_usd)) over () share
from cost_savings where created_at >= now() - interval '30 days' group by 1 order by saved desc;

-- retrieval score vs dissatisfaction (justifies the no-answer threshold)
select width_bucket(r.top1_score, 0, 1, 10) bucket, count(*) n,
       avg((f.rating = -1)::int) thumbs_down_rate, avg(q.score) groundedness
from rag_requests r left join feedback f on f.request_id = r.id
left join quality_checks q on q.request_id = r.id and q.check_type = 'groundedness'
where r.status = 'answered' group by 1 order by 1;

-- per-user budget status
select b.user_id, b.daily_limit_usd, coalesce(u.spent_usd,0) spent, coalesce(u.reserved_usd,0) reserved
from user_budgets b left join user_daily_usage u on u.user_id=b.user_id
 and u.day=(now() at time zone 'Europe/Bratislava')::date;
```

---

## 5. Interview demo: what impresses and how to make it credible

**Metrics and graphs, in priority order:**

1. **A README eval table plus a Pareto chart** (quality vs $/query) across the config sweep, with n, CIs and paired-bootstrap deltas.
2. **In-app Ops page** (React + Recharts):
   - KPI tiles: $/query, cache hit %, estimated $ saved, p95 TTFT, no-answer %, thumbs-up %, sampled groundedness
   - cost per day stacked by `purpose`
   - **savings waterfall** (baseline → prompt cache → semantic cache → no-answer gate → actual)
   - latency p50/p95 by stage
   - top-1 score bucket vs thumbs-down rate
3. **A live budget stop:** set your own limit to $0.001, show the 429 and the UI message, and explain the atomic reservation SQL.
4. **A thumbs-down row deep-linked to its Langfuse trace**, showing the retrieved chunks.
5. **Semantic-cache threshold curve** (hit rate vs wrong-hit rate).
6. **Judge-vs-human agreement** on 30 labels.
7. **Security numbers:** "0/5 planted injections succeeded, 0 cross-tenant retrievals in N probes". Stretch: a promptfoo red-team report.
8. Stretch: **cost reconciliation** against the OpenAI Costs API, e.g. "within X%".
9. A model-migration story: gpt-4.1-nano and gpt-5-nano are being retired, so switching models is one config change plus an eval run showing the delta.

**How to keep it credible:**
- Populate the dashboards with a **replay script** that sends golden and paraphrased questions through the real API, using 2–3 Cognito test users. Label the data "synthetic replay traffic (date)".
- Run the replay twice, **with optimisations off and on**, so savings are *measured*, and show the per-request attributed estimate next to it.
- Commit the results JSON with SHA and config hash, and make it reproducible with `make eval` / `make demo-data`.
- State the caveats yourself: n≈60, judge bias, synthetic traffic.
- Never put invented numbers in the README. Fill every cell from `results/*.json`.

**Where it fits in the 2 weekends:**
- **Weekend 1** (about 3h total; cheap now, painful to retrofit):
  - `model_prices` seed, `llm_calls`, `rag_requests`, `retrievals`
  - `trace_id` propagation, Langfuse keys and SDK
  - thumbs up/down
- **Weekend 2, Saturday:**
  - golden set: RAGAS generation plus review (~3h)
  - harness tier 1 + RAGAS judge + 30-minute compatibility spike (~3h)
  - sweep + report (~2h)
- **Weekend 2, Sunday:**
  - Ops dashboard (~3h)
  - budget enforcement (~1.5h)
  - groundedness worker (~1.5h)
  - injection heuristics (~1h)
  - A/B replay (~1h)
- **Stretch:** promptfoo red-team, Costs API reconciliation, judge calibration with Sol.

## 6. Unverified points and risks

- **Not verified:**
  - Frankfurt EC2 prices (only the US baseline for t3.xlarge, ~$0.166/h)
  - the exact Langfuse env-var names for disabling or sampling tracing
  - whether Chat Completions exposes `cache_write_tokens`
  - whether `input_tokens` includes `cache_write_tokens` (assert it on the first real responses)
  - Phoenix RAM needs (third-party claim)
  - the LangSmith overage rate
  - all eval and query cost figures (my arithmetic from list prices)
  - the gpt-5.6-luna cache-write price (search summary only)
  - whether Langfuse's built-in price list includes gpt-6-luna
- **Risks:**
  - RAGAS release staleness and reasoning-model parameter mapping
  - the Langfuse `trace_context` phantom-parent issue
  - GenAI semconv still pre-release
  - gpt-6-luna is 2 days old, with no independent quality track record yet; that's why judge calibration matters
- **Demo corpus:** the license of any public document set (e.g. a public company handbook) needs checking.

## Sources

- [Langfuse pricing](https://langfuse.com/pricing)
- [Langfuse self-hosting architecture](https://langfuse.com/self-hosting)
- [Langfuse Docker Compose sizing](https://langfuse.com/self-hosting/deployment/docker-compose)
- [Langfuse data regions](https://langfuse.com/security/data-regions)
- [Langfuse EU data residency](https://langfuse.com/resources/engineering/langfuse-eu-data-residency-gdpr)
- [Langfuse OpenTelemetry](https://langfuse.com/docs/opentelemetry/get-started)
- [Langfuse token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [Langfuse SDK overview](https://langfuse.com/docs/observability/sdk/overview)
- [Langfuse JS v4→v5 upgrade (span filter)](https://langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5)
- [Langfuse unwanted HTTP/DB spans FAQ](https://langfuse.com/faq/all/unwanted-http-database-spans)
- [Langfuse distributed tracing](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing)
- [Langfuse trace_context phantom parent issue #12896](https://github.com/langfuse/langfuse/issues/12896)
- [Langfuse masking](https://langfuse.com/docs/observability/features/masking)
- [Langfuse scores via SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk)
- [Langfuse LangChain integration](https://langfuse.com/integrations/frameworks/langchain)
- [Langfuse LlamaIndex integration](https://langfuse.com/integrations/frameworks/llamaindex)
- [langfuse on PyPI](https://pypi.org/project/langfuse/)
- [LangSmith pricing](https://www.langchain.com/pricing)
- [arize-phoenix on PyPI](https://pypi.org/project/arize-phoenix/)
- [Phoenix self-hosting](https://arize.com/docs/phoenix/self-hosting)
- [Phoenix configuration](https://arize.com/docs/phoenix/self-hosting/configuration)
- [Phoenix sizing (third party)](https://theneuralbase.com/arize-phoenix/learn/advanced/commercial-production-platform/)
- [OTel GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [OTel blog: GenAI observability 2026](https://opentelemetry.io/blog/2026/genai-observability/)
- [semantic-conventions-genai repo issue](https://github.com/open-telemetry/semantic-conventions-genai/issues/510)
- [ragas on PyPI](https://pypi.org/project/ragas/)
- [ragas releases](https://github.com/vibrantlabsai/ragas/releases)
- [ragas GPT-6 issue #3031](https://github.com/vibrantlabsai/ragas/issues/3031)
- [ragas gpt-5.2 max_completion_tokens issue #2573](https://github.com/vibrantlabsai/ragas/issues/2573)
- [RAGAS available metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)
- [RAGAS Faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/)
- [RAGAS Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)
- [RAGAS Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)
- [RAGAS Answer Relevancy](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/)
- [RAGAS testset generation](https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/)
- [deepeval on PyPI](https://pypi.org/project/deepeval/)
- [promptfoo RAG evaluation guide](https://www.promptfoo.dev/docs/guides/evaluate-rag/)
- [promptfoo indirect prompt injection plugin](https://www.promptfoo.dev/docs/red-team/plugins/indirect-prompt-injection/)
- [promptfoo on npm](https://www.npmjs.com/package/promptfoo)
- [OpenAI to acquire Promptfoo](https://openai.com/index/openai-to-acquire-promptfoo/)
- [TechCrunch: OpenAI acquires Promptfoo](https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-5.6 Luna on OpenRouter](https://openrouter.ai/openai/gpt-5.6-luna)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)
- [OpenAI Usage/Cost API cookbook](https://developers.openai.com/cookbook/examples/completions_usage_api)
- [Llama Prompt Guard 2 86M](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- [Llama Prompt Guard 2 model card](https://www.llama.com/docs/model-cards-and-prompt-formats/prompt-guard/)
- [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf)
- [Vantage: t3.xlarge](https://instances.vantage.sh/aws/ec2/t3.xlarge?region=eu-central-1)
- [Vantage: t4g.medium](https://instances.vantage.sh/aws/ec2/t4g.medium?region=eu-central-1)
