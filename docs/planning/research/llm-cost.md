# SmartDoc AI: LLM and embedding layer, cost levers (as of 2026-09-25)

Sources are checked against OpenAI's docs as of today. Anything marked **[UNVERIFIED]** I could not confirm from a primary source.

**Caching changed for GPT-5.6 and later, which includes GPT-6.** Cache reads now cost 0.1x the input price. Cache writes now cost **1.25x** the input price. The default "implicit" caching mode writes the whole prompt up to the latest user message into the cache. In single-turn RAG the retrieved chunks change on every query, so that prompt is almost never reused. The result is that the default settings make RAG input about 25% more expensive. The prompt layout needs to be designed with this in mind.

---

## 1. OpenAI chat models: cheapest viable options

Prices are USD per 1M tokens, Standard tier. The per-query column uses the baseline query from section 4: 3,050 input tokens and 300 output tokens, no caching, no reasoning tokens.

| Model | Input | Cached input | Cache write | Output | Context / max output | Reasoning effort | Status | Cost per baseline query |
|---|---|---|---|---|---|---|---|---|
| **gpt-6-luna** | 0.10 | 0.01 | 0.125 | 0.50 | 1.05M (922k input) / 128k | none, low, **medium (default)**, high, xhigh, max | Released 2026-09-22. Only an alias exists, no dated snapshot | **$0.00046** |
| **gpt-6-sol** | 2.00 | 0.20 | 2.50 | 10.00 | 1.05M / 128k | none … max, default medium | Released 2026-09-22 | $0.0091 |
| gpt-5.6-luna | 0.20 | 0.02 | 0.25 | 1.20 | 1.05M / 128k | none … max, default medium | Current ("nano tier") | $0.00097 |
| gpt-5.6-terra | 2.00 | 0.20 | 2.50 | 12.00 | 1.05M / 128k | none … max | Current ("mini tier") | $0.0097 |
| gpt-5.4-nano | 0.20 | 0.02 | none | 1.25 | 400k (272k input) / 128k | **none (default)**, low … xhigh | Current, snapshot 2026-03-17 | $0.00099 |
| gpt-5.4-mini | 0.75 | 0.075 | none | 4.50 | 400k / 128k | none (default) … xhigh | Current | $0.0036 |
| gpt-5-nano | 0.05 | 0.005 | none | 0.40 | 400k / 128k | reasoning model (effort values not re-verified) | **Shuts down 2026-12-11** | $0.00027 |
| gpt-5-mini | 0.25 | 0.025 | none | 2.00 | 400k / 128k | reasoning model | **Shuts down 2026-12-11** | $0.0014 |
| gpt-4.1-nano | 0.10 | 0.025 | none | 0.40 | 1.05M / 32k | no reasoning | **Shuts down 2026-10-23** | $0.00043 |
| gpt-4.1-mini | 0.40 | 0.10 | none | 1.60 | 1.05M / 32k | no reasoning | Legacy | $0.0017 |
| gpt-4o-mini | 0.15 | 0.075 | none | 0.60 | 128k / 16k | no reasoning | Legacy, knowledge cutoff Oct 2023 | $0.00064 |

- **Features.** Every model above supports streaming and Structured Outputs through both Chat Completions and Responses, and supports Batch.
- **Batch and Flex** cost 50% of Standard. For GPT-6 Luna that is $0.05 input / $0.005 cached / $0.25 output.
- **Fast mode** (renamed from "priority") costs 2x.
- **Long prompts.** A GPT-6 prompt over 272k input tokens is billed at 2x input and 1.5x output for the whole request.
- **EU data residency** adds 10%, and for GPT-6 only on Standard processing.
- **Reasoning tokens.** They are billed as output tokens. They are already included in `output_tokens`; `reasoning_tokens` is only a breakdown, so do not add it again.
- **Luna's default effort is `medium`.** Leaving it unset quietly adds reasoning tokens, which are billed at the output rate and add latency.
- **`max_output_tokens` / `max_completion_tokens` include reasoning tokens.** If effort is above `none` and the cap is tight, the response can end `incomplete` with no visible text and you still pay for it.
- **Temperature.** `temperature` and `top_p` are only allowed when effort is `none`.
- **Tool calling.** Chat Completions supports function calling on GPT-6 Sol and Luna only with `reasoning_effort: "none"`.

**DEFAULT: `gpt-6-luna`, `reasoning.effort: "none"`, `text.verbosity: "low"`, `max_output_tokens: 600`**
- It is the cheapest current model that is not being shut down. It beats gpt-4o-mini on price (1.5x cheaper input, 1.2x cheaper output), gpt-5.6-luna (2x / 2.4x cheaper) and gpt-5.4-nano. The only cheaper or equal models, gpt-5-nano and gpt-4.1-nano, shut down on 2026-12-11 and 2026-10-23. Those dates fall in your interview window.
- Cached input has a 90% discount, and explicit cache breakpoints give you control over what gets cached (section 3).
- Using the same family as the escalation model means one tokenizer, one set of caching rules, one parameter set and one prompt. That keeps the eval comparison clean.
- **Risk:** the model is 3 days old, has no dated snapshot, and the only quality evidence is OpenAI's own. TechCrunch reports "about half as many mistakes" on OpenAI's internal factuality eval, but that figure is for Sol, not Luna.
- **Mitigation:** keep the model ID in config, keep gpt-5.6-luna as the fallback, and re-run the golden-set eval on a schedule.
- **Decide `none` vs `low` with the eval, not by assumption.**

**ESCALATION: `gpt-6-sol`, `reasoning.effort: "low"`**
- Per query it costs about 20x Luna at `none`, and about 27x if you assume about 300 reasoning tokens.
- It is the same price as gpt-5.6-terra and cheaper on output, so it beats Terra.
- **Cheaper middle step worth A/B testing:** keep Luna and raise effort to `medium` ("effort escalation"). OpenAI claims Luna at higher effort matches GPT-5.6 Sol **[vendor claim, UNVERIFIED]**.
- In multi-turn Responses conversations, a `configuration_update` input item changes effort without rewriting the cached prefix.

---

## 2. Embeddings

| Model | $ / 1M tokens | Default dims | `dimensions` parameter | MTEB | MIRACL (multilingual) |
|---|---|---|---|---|---|
| **text-embedding-3-small** | 0.02 | 1536 | yes | 62.3 | 44.0 |
| text-embedding-3-large | 0.13 | 3072 | yes | 64.6 | 54.9 |
| text-embedding-ada-002 | 0.10 | 1536 | no | 61.0 | 31.4 |

- **No newer embedding model exists.** The API enum is still only these three.
- **Limits:** up to 8,192 tokens per input, up to 2,048 inputs per request, and up to **300k tokens per request** in total. A whole 100-page document fits in one call.
- **Tokenizer:** `cl100k_base`. Use it for chunk-size math.
- **Matryoshka reduction.** The v3 models were trained with MRL (arXiv 2205.13147), so `dimensions: N` shortens the vector with little loss. Per OpenAI, 3-large cut to 256 dims still beats ada-002 at 1536. The finer numbers I remember (3-small@512 ≈ 61.6, 3-large@256 ≈ 62.0, 3-large@1024 ≈ 64.1) are **[UNVERIFIED]**: the OpenAI blog returned 403.
- **Normalization.** Use the API parameter. If you cut vectors yourself you have to re-normalize them (L2).

**pgvector implications (v0.8.6)**
- HNSW and IVFFlat can index a `vector` column up to **2,000 dims**, a `halfvec` up to **4,000**, and a `bit` column (binary quantization) up to 64,000.
- Storage per row: `vector` = 4·d + 8 bytes (1536 → 6,152 B), `halfvec` = 2·d + 8 bytes.
- 3-large at the full 3072 dims would need `halfvec`. 3-large at 1024 or 3-small at 1536 fit a plain `vector`.
- **Per-user filtering:** HNSW applies the WHERE filter after the index scan. With the default `hnsw.ef_search = 40`, a `WHERE user_id = …` query can return fewer than k rows. Use `SET hnsw.iterative_scan = strict_order` (available since 0.8.0), or per-user partial indexes.

**Recommendation:** start with `text-embedding-3-small` at **1536** dims in a `vector(1536)` column with HNSW `vector_cosine_ops`.
- Store `embedding_model` and `dims` on each chunk so re-embedding is a clean migration.
- On the golden set, run a retrieval eval (recall@5 / MRR) over {3-small@1536, 3-small@512, 3-large@1024}.
- **If the documents are Slovak or mixed-language, expect 3-large@1024 to win.** The MIRACL gap is 44.0 vs 54.9.
- Embedding API cost does not drive this decision (section 4 shows it is noise). Retrieval quality and index size do.

---

## 3. OpenAI cost features

### Prompt caching on GPT-5.6+ and GPT-6 (Luna and Sol)
- **Always on.** Reads cost 0.1x input, writes cost 1.25x input. Writes replace the normal rate for those tokens; they are not an extra fee on top.
- **Minimum 1,024 visible tokens** before anything is cached.
- **Lifetime:** `prompt_cache_options.ttl: "30m"` is the only value. The cache lasts at least 30 minutes after the last write or read, and a read refreshes it for free.
- **Two modes:**
  - `implicit` (default): one breakpoint at the end of the latest user message.
  - `explicit`: only the breakpoints you mark with `prompt_cache_breakpoint: {mode:"explicit"}`, up to 4 writes per request. **If you mark none, nothing is cached and nothing is written.**
- **Both APIs support it.** The Chat Completions reference also lists `prompt_cache_options`, content-part breakpoints and `cache_write_tokens`.
- **Gotcha (Responses API):** the top-level `instructions` field cannot hold a breakpoint. Put the static prompt in a developer message as an `input_text` block.
- **`prompt_cache_key` is optional on GPT-5.6+ and only separates cache accounting.** A per-user key would split the shared system-prompt cache into one copy per user. **Do not set it per user for the static prefix.**
- **Privacy:** because only the static, non-user prefix is ever written to the cache, other users cannot probe it to learn whether someone's document content was cached. That is a good point for the interview.
- **Older models** (gpt-5.5 and earlier): implicit caching only, no write charge, and `prompt_cache_key` affects routing (about 15 requests per minute per key). The discount varies by model: 90% on the gpt-5 family, 75% on gpt-4.1, 50% on gpt-4o-mini.

**Prompt layout for this project (explicit mode):**
```
[developer: static rules + citation format + few-shot examples, expanded to ≥1,024 tokens] ▼breakpoint
[history (truncated)]  [user: <context chunks> + question]   ← charged at the normal input rate, never written to cache
```
- **Minimum-length trap:** a 600-token system prompt can never be cached. OpenAI's break-even formula is L = M(r + (w−r)/N). With M = 1,024, r = 0.1 and w = 1.25, padding 600 tokens up to 1,024 pays off once at least **3 requests** hit within one 30-minute window.
- **Use the padding for useful few-shot citation examples**, not filler.
- **Responses-only extra:** `prompt_cache_options.prewarm: true` (writes are billed) can warm the cache on login.

### Batch and Flex
- **Batch:** 50% off, results within 24 hours, supports `/v1/embeddings`. **Not usable for interactive upload**, and it would save only about $0.0006 per 100-page document. Use it only for bulk re-embedding (a model or dims migration) and offline eval generation. The pricing page does not list a separate embeddings batch price; the Batch guide says 50% across endpoints.
- **Flex:** set `service_tier: "flex"` on a Responses or Chat call to get Batch prices, in exchange for slower answers and occasional "resource unavailable" errors. **Use it for eval and LLM-judge runs and optional background enrichment. Never for user chat.** It does not cover embeddings.

### Usage fields (the source of truth for the cost ledger)
- **Responses API:**
  - `usage.input_tokens`
  - `input_tokens_details.cached_tokens` and `.cache_write_tokens`
  - `output_tokens`
  - `output_tokens_details.reasoning_tokens`
  - When streaming, the final `response.completed` event carries `response.usage`.
- **Chat Completions:**
  - `usage.prompt_tokens`
  - `prompt_tokens_details.cached_tokens` and `.cache_write_tokens`
  - `completion_tokens_details.reasoning_tokens`
  - When streaming, you need `stream_options: {include_usage: true}`. The final chunk has `usage` and empty `choices`. **If the stream is interrupted, that usage chunk may never arrive.** Log those calls as estimated.
- **Cost formula (from OpenAI's docs):** `ordinary = input − cached − cache_write`, then `cost = (ordinary·p_in + cached·p_cached + cache_write·p_write + output·p_out) / 1e6`.

### Chat Completions vs Responses
- For stateless RAG, both support everything that matters for cost.
- **Recommendation: Responses API, stateless.** Set `store: false` (the default is true, which keeps responses for at least 30 days). Do not use `previous_response_id`; keep history in Postgres. Set `safety_identifier` to a hashed Cognito `sub`.
- **Why Responses:**
  - OpenAI recommends it for new projects.
  - Prewarm and `configuration_update` exist only there.
  - The docs' caching examples use Responses.
  - Usage arrives without an extra flag.
- **Don't cite as your own result:** OpenAI's "40–80% better cache utilization" comes from its internal tests of reasoning models in multi-turn state.
- **LangChain note:** `langchain-openai` master supports `use_responses_api=True` and `prompt_cache_options`, and maps `cache_write_tokens` to `usage_metadata.input_token_details.cache_creation`. Check that your pinned 1.6.6 has this.

### Tokenizers
- tiktoken 0.14.0 maps the `gpt-5*` prefix to `o200k_base` and the embedding models to `cl100k_base`.
- **tiktoken has no `gpt-6-*` entry, so `encoding_for_model("gpt-6-luna")` raises KeyError.** Whether GPT-6 uses `o200k_base` is **[UNVERIFIED]**.
- Use `o200k_base` only for budget estimates before a call. Use API `usage` for billing. For an exact pre-count, use `responses.input_tokens.count`.
- Slovak text will likely use more tokens per word than English **[UNVERIFIED ratio: measure it]**.

---

## 4. Cost estimates, with the math

### Ingesting a 100-page PDF (~50k tokens)
**Assumptions:** 400-token chunks with 50 tokens of overlap, so a stride of 350 → about 143 chunks → about 57,200 tokens to embed.

| Step | Math | Cost |
|---|---|---|
| Embed, 3-small | 57,200 × $0.02/1M | **$0.0011** (one API call) |
| Embed, 3-large | 57,200 × $0.13/1M | $0.0074 |
| Same via Batch API (3-small) | ×0.5 | $0.0006 (not worth the wait of up to 24 hours) |
| Optional document summary (Luna) | 50k × 0.10 + 300 × 0.50 | $0.0052 (**about 5x the embedding cost**) |
| Optional per-chunk context headers ("contextual retrieval"), no cache | 143 × 50,400 × 0.10 + 143 × 60 × 0.50 | $0.725 |
| Same, with an explicit breakpoint after the document | write 50k × 0.125 = $0.0063; reads 142 × 50k × 0.01 = $0.071; chunks 143 × 400 × 0.10 = $0.0057; output $0.0043 | **$0.087 (−88%)** |

Storage for 143 × 6,152 B is about 0.9 MB of raw vectors, plus the index. **Embedding costs a fraction of a cent. The only expensive part of ingestion is LLM enrichment, and that is where caching pays off most.**

### A typical chat query on gpt-6-luna (effort `none`, so 0 reasoning tokens)
Input = 600 system + 2,000 chunks + ~400 history + ~50 question = **3,050 tokens**. Output = **300 tokens**.

| Variant | Math | Cost per query | Per 1k queries |
|---|---|---|---|
| A. Baseline, no cache (prefix under 1,024) | 3,050 × 0.10 + 300 × 0.50 = 305 + 150 µ$ | **$0.000455** | $0.46 |
| B. **Default implicit mode** (whole prompt written, never reused) | 3,050 × 0.125 + 150 | $0.000531 (**+17%**) | $0.53 |
| C. Explicit mode, 1,024-token static prefix, warm cache | 1,024 × 0.01 + 2,450 × 0.10 + 150 = 10 + 245 + 150 | **$0.000405 (−11%)** | $0.41 |
| D. C plus a context budget (top-3 = 1,200 tokens) and 200 output tokens | 10 + 1,650 × 0.10 + 200 × 0.50 | $0.000275 (−40%)* | $0.28 |
| E. gpt-6-sol, effort `low` (~300 reasoning tokens assumed) | 3,050 × 2 + 600 × 10 | $0.0121 (≈27x) | $12.10 |
| Routing: 90% C + 10% E | 0.9 × 0.000405 + 0.1 × 0.0121 | $0.00157 (**Sol is 77% of the spend**) | $1.57 |

\* Only if the eval shows no loss in quality.

- **Extra costs:**
  - A cold cache write costs 1,024 × 0.125 = $0.000128 once per 30-minute idle window, about 0.3 of a query.
  - Rewriting a follow-up question into a standalone one costs about 500 input + 40 output on Luna ≈ $0.00007.
  - The query embedding costs about $0.000001.
- **Caching saves only about 10% on RAG,** because most of the input is freshly retrieved chunks. The bigger levers are the context budget, output caps, and reasoning effort.
- **"Why not just stuff the whole document?"** Luna's 1M context with the document cached costs $0.00625 per cold write, then about $0.0005 + $0.00015 ≈ **$0.00065 per query**. That is cost-competitive with RAG for **one** small document. RAG wins on:
  - multi-document corpora (100 documents × 50k = 5M tokens, which is over the context limit);
  - cold caches (the TTL is 30 minutes);
  - per-user scoping;
  - citation granularity;
  - latency.
  This is a strong defensive answer in an interview.
- **Demo scale:** 10 users × 20 queries/day × 30 days = 6k queries ≈ **$2.4/month**, plus about $0.1 for ingestion. At this scale the EC2 bill dominates, so present the cost story as unit economics per 1k queries: at 1M queries/month, Luna costs about $405–455 versus about $12k for Sol.

---

## 5. Application-level optimizations, ranked by impact vs effort

| # | Lever | Effort | Expected savings | Main risk | How to measure credibly |
|---|---|---|---|---|---|
| 1 | **Explicit `effort:"none"` + `max_output_tokens` + `verbosity:"low"`** | 15 min | Avoids reasoning tokens at Luna's default `medium`. Probably a 30–70% cost cut **[UNVERIFIED; depends on how many reasoning tokens it produces]**. Output is 33% of query cost. | Lower quality on multi-hop questions. Truncated answers. | Distributions of `reasoning_tokens` and `output_tokens`. Truncation rate (`incomplete` / `finish_reason=length`). Eval of `none` vs `low`. |
| 2 | **Per-user daily budgets + OpenAI project hard spend limit** | 2–3 h | Caps the worst case (abuse, loops). No effect on average cost. Required for a public demo. | User friction. | Atomic Postgres usage ledger checked before each call. Show that no user's daily spend exceeds the cap by more than one in-flight request. Count 429s. |
| 3 | **Context token budget** (top-k and score cutoff, max context tokens, drop near-duplicate chunks) | 2–4 h + eval | 20–40% per query (chunks are 44% of cost). | Lower recall leads to "not found" answers. | Golden-set sweep of k ∈ {3, 5, 8}: context recall, faithfulness, cost/1k. Pick the knee of the curve. |
| 4 | **Cache-aware layout** (static prefix ≥1,024 tokens first, explicit breakpoint, dynamic suffix never written) | 1–2 h | About 10% per query. Avoids the +17% implicit-mode penalty. Up to −88% on document-level LLM enrichment. | Padding the prompt could change behavior. | Token hit rate = Σcached / Σinput. Σcache_write. Cost/query before vs after on a replayed log. Eval shows no regression. |
| 5 | **History budget** (last N turns or ≤800 tokens; question rewriting for retrieval) | 1 h | Stops input from growing linearly with turns. Large savings from about turn 5 on. Skip summarization: it adds a call and breaks the cached prefix. | Losing things the user referred to earlier. | Plot input tokens against turn index. Multi-turn subset of the golden set. |
| 6 | **Exact-match response cache.** Key = hash(user_id, normalized standalone question, corpus_version, model, prompt_version, retrieval params). Cache only turn-1 or rewritten questions. | 2–3 h | 100% on a hit. Organic hit rate is probably low (single digits, **[UNVERIFIED]**). High for suggested demo questions. | Stale answers after a document change. Solved by putting a hash of the user's (doc_id, content_hash) list in the key. | Hit rate from logs. A test that proves a document change misses the cache. Report replay-log assumptions explicitly (for example "20% repeats"). |
| 7 | **Content-hash dedup** (sha256 of the document, to reject exact re-uploads; per-chunk hash to skip re-embedding) | 1–2 h | Embedding money is negligible. The real gains are storage and no duplicate chunks filling top-k (v1 and v2 of a policy). | Normalization bugs that miss near-duplicates. | % of chunks skipped when a revised document is re-uploaded. Rate of duplicates in top-k before vs after. |
| 8 | **Model routing.** Escalate on a Luna structured-output flag (`needs_escalation` / low confidence), failed citation validation, multi-document or comparison questions, or a user-clicked "Deep answer". **Never escalate on weak retrieval: answer "not in your documents".** | 0.5–1 day | Compared with all-Sol: about −90%. Compared with all-Luna: it costs more (a quality spend). | Escalation cost dominates. Luna misjudging its own confidence. | Escalation rate (target ≤5%). Quality lift on the escalated subset. A cost-vs-quality chart (Pareto) of all-Luna, routed and all-Sol. |
| 9 | **Semantic cache** (reuses the query embedding already computed, so no extra embedding cost; same key scoping as #6; shown with a "cached" badge and a regenerate button) | 1–1.5 days | Low for private, per-user corpora. The strongest published claim is 61.6–68.8% hits on repetitive customer-service traffic. | **A wrong answer served with full confidence.** Practitioners see false positives climb as the threshold drops (reported: 0.95 → low single digits, 0.90 → 8–15% on broad chat). Thresholds do not carry over between embedding models. | A labeled set of paraphrase pairs and near-miss pairs ("full-time vs part-time leave"). Precision of cache hits per threshold, target false-positive rate ≤1–2%. Hit rate on the replay log. **Put it behind a flag. If it doesn't pass, say so and explain why.** |
| 10 | **Flex for eval and judge runs** | 5 min | 50% off eval spend (≈$1–1.5 per 100-question run with a Sol judge → about half) **[estimate]** | Slower runs, retries. | Compare cost per eval run. |

**Measurement protocol for interview-grade claims:**
- **Cost ledger:** one `llm_calls` row per call with purpose (answer / rewrite / judge / summary), model, tier, effort, the four token counts, `cost_usd` computed from a **versioned price table**, latency, time to first token (TTFT), app-cache status, and routing decision. Reconcile a day's total against the OpenAI usage dashboard (target within ±2%).
- **Ablation table:** on a fixed golden set of 50–100 questions plus a replayed synthetic log, toggle each lever on and off. Report $/1k queries, p50/p95 latency, and faithfulness / answer relevancy / context recall / citation accuracy.
- **Eval tooling:** **OpenAI's Evals platform shuts down on 2026-11-30.** Use Ragas (0.4.3) or promptfoo. Because Luna has no dated snapshot, date-stamp every eval result.

**Suggested weekend split:**
- **Weekend 1:** #1, the usage ledger, the `store:false` config.
- **Weekend 2:** #2–7, then #8 in its simple form (flag or button), then #9 as a flagged experiment, then #10.

---

**[UNVERIFIED] summary:**
- MTEB scores at reduced dims.
- GPT-6's tokenizer.
- How many reasoning tokens Luna produces at `medium`.
- Luna's "matches GPT-5.6 Sol" claim.
- Organic exact-cache hit rates.
- Semantic-cache false-positive numbers (vendor and practitioner blogs, not independent benchmarks).
- Whether generation stops, and billing ends, when the client disconnects mid-stream.
- The size of pgvector HNSW index overhead.
- Whether pinned langchain-openai 1.6.6 includes the caching support seen in master.

## Sources
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) ([markdown](https://developers.openai.com/api/docs/pricing.md))
- Model pages: [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [gpt-5.4-nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [gpt-5-nano](https://developers.openai.com/api/docs/models/gpt-5-nano), [gpt-5-mini](https://developers.openai.com/api/docs/models/gpt-5-mini), [gpt-4.1-nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano), [gpt-4.1-mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [gpt-4o-mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)
- [Using GPT-6 (migration/limits)](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra)
- [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Reasoning models guide](https://developers.openai.com/api/docs/guides/reasoning)
- [Batch API](https://developers.openai.com/api/docs/guides/batch), [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing)
- [Embeddings guide](https://developers.openai.com/api/docs/guides/embeddings), [Embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat), [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create), [Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Token counting](https://developers.openai.com/api/docs/guides/token-counting)
- [Deprecations](https://developers.openai.com/api/docs/deprecations)
- [Production best practices (hard spend limits)](https://developers.openai.com/api/docs/guides/production-best-practices), [Rate limits and spend](https://developers.openai.com/api/docs/guides/terraform/rate-limits-and-spend), [Your data (retention/residency)](https://developers.openai.com/api/docs/guides/your-data)
- [TechCrunch: GPT-6 Sol and Luna launch (2026-09-22)](https://techcrunch.com/2026/09/22/openai-launches-gpt-6-sol-and-luna/), [GitHub changelog](https://github.blog/changelog/2026-09-22-openais-gpt-6-sol-and-gpt-6-luna-now-available/), [Introducing GPT-6 Sol and Luna (403, not read)](https://openai.com/index/introducing-gpt-6-sol-and-luna/)
- [pgvector README (v0.8.6)](https://github.com/pgvector/pgvector)
- [tiktoken model map](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py), [tiktoken on PyPI (0.14.0)](https://pypi.org/project/tiktoken/), [openai on PyPI (3.19.2)](https://pypi.org/project/openai/), [langchain-openai on PyPI (1.6.6)](https://pypi.org/project/langchain-openai/)
- [langchain-openai ChatOpenAI source (caching/usage mapping)](https://github.com/langchain-ai/langchain/blob/master/libs/partners/openai/langchain_openai/chat_models/base.py)
- [Pinecone: OpenAI embeddings v3 benchmarks](https://www.pinecone.io/learn/openai-embeddings-v3/), [OpenAI v3 embeddings blog (403, not read)](https://openai.com/index/new-embedding-models-and-api-updates/), [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147)
- [GPT Semantic Cache paper](https://arxiv.org/abs/2411.05276), [Portkey: semantic caching thresholds](https://portkey.ai/blog/semantic-caching-thresholds/), [Spheron semantic cache guide](https://www.spheron.network/blog/semantic-cache-llm-inference-gpu-cloud/)
