# Review: interviewer

## Verdict

The plan is strong: the goals are measurable, the decisions are recorded, and failure modes are considered. Most candidates arrive with far less. It still has four places a senior interviewer will attack.

1. **Too much scope for 40 hours.** There are about 30 deliverables, 24 ADRs and 3 observability surfaces. Interviewers drill into one area, and a shallow piece will cost more credibility than a missing one.
2. **"Enterprise" does not match the tenancy model.** The tenant is a single user, yet the app is for company documents that every employee needs. This also makes the response cache nearly useless, which weakens the cost story.
3. **The savings numbers are easy to challenge.** The naive baseline is a strawman, the replay's repeat ratio is chosen by the author, and the prompt-cache percentages do not reconcile with the arithmetic. In absolute terms, AWS infra (about $21.6/month at list price) dwarfs LLM spend (about $2.5/month) until roughly 54k queries/month.
4. **Concrete correctness bugs:**
   - `websearch_to_tsquery` ANDs every term, so the hybrid search is effectively vector-only and the gate is mostly cosine-only.
   - `ts_rank_cd` is not BM25.
   - The budget reservation returns 429 on the first request of each day, because today's usage row does not exist yet.
   - Citation validity = 1.0 is trivially satisfied.
   - The tier-1 CI gate depends on live, non-deterministic LLM output.
   - There is no consistency or idempotency between Python's ledger rows and NestJS's message rows.
   - RPO, RTO and SLOs are not stated.

Fix these and the project is very defensible.

**Verified today:**
- **OpenAI pricing:** gpt-6-luna costs $0.10 input / $0.01 cached / $0.125 cache write / $0.50 output per 1M tokens. Cache writes cost 1.25× on GPT-5.6+. Batch and Flex are −50%. EU residency is +10% and works only with Standard processing.
- **Prompt caching:** explicit mode uses `prompt_cache_breakpoint: {"mode":"explicit"}`, allows up to 4 writes per request, and the only TTL is `prompt_cache_options.ttl` = "30m". The minimum is 1,024 visible input tokens.
- **gpt-6-luna model:** undated alias. Default effort is medium; effort `none` is supported. Tier 1 limits are 500 RPM / 500K TPM. Input above 272K tokens is billed at 2×.
- **Shutdown dates:** gpt-5-nano on 2026-12-11, gpt-4.1-nano on 2026-10-23.
- **CloudFront flat-rate Free plan:**
  - 1M requests and 100 GB included; 5 WAF rules in total; 5 cache behaviors.
  - No custom response-header policies and no VPC origins.
  - Accounts on AWS Free Tier are not eligible, and a Web ACL must stay attached.
- **T4g trial:** runs to 2026-12-31.
- **pgvector 0.8.6:** HNSW on halfvec supports up to 4,000 dims. Storage is 2·d+8 bytes per halfvec (3,080 B at 1536 dims). `hnsw.max_scan_tuples` defaults to 20,000.
- **RAGAS:** 0.4.3 is the latest release and dates from 2026-01-13, before GPT-6.
- **Langfuse Hobby:** 50k units/month, 30-day data access, 2 users, no paid overage.
- **Postgres FTS:** `websearch_to_tsquery` ANDs terms, and `ts_rank_cd` uses no global (IDF) statistics.

**Not verified:**
- Fargate, ALB and RDS prices in eu-central-1 (the figures below are approximate).
- HNSW index bytes per vector (about 3.3–3.5 KB is my estimate).
- The t4g CPU-credit baseline.
- Whether implicit-mode caching allows partial-prefix hits (the +17% figure assumes it does not).
- Whether `temperature` is accepted at effort `none`.

**Sources:**
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/deprecations
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
- https://repost.aws/articles/ARi_gf6vo6TuqNtMQdiYPKyA/announcing-amazon-ec2-t4g-free-trial-extension
- https://www.postgresql.org/docs/current/textsearch-controls.html
- https://github.com/pgvector/pgvector
- https://pypi.org/project/ragas/
- https://langfuse.com/pricing
- https://aws.amazon.com/fargate/pricing/ (eu-central-1 rates not verified)
- https://aws.amazon.com/elasticloadbalancing/pricing/ (eu-central-1 rates not verified)

## Issues

### Critical (3)

**1. Scope / timeline**

- **Problem:** 40 h covers about 30 deliverables: 5 CDK stacks, CI/CD, an eval harness with RAGAS and a 12-config sweep, two caches, budgets, Langfuse, a custom Ops dashboard, RLS, replay, 24 ADRs, PRD, ARCHITECTURE and INTERVIEW. 24 ADRs plus 3 docs in 1.5 h will read as generated. Interviewers pick one component and drill until they hit the bottom, so shallow breadth is the main credibility risk.
- **Fix:** Define an interview-critical path and treat the rest as stretch:
(1) the working demo;
(2) a README eval table with 2 real ablations (hybrid on/off, k);
(3) the cost replay with a waterfall;
(4) tenant-isolation tests;
(5) the HTTPS deploy with CI.
Move the semantic cache, RLS, the custom dashboard beyond 4 tiles, and the model trio to stretch. Cut the ADRs to 8–10, each with one measured number; keep the rest as rows in the decision register. Keep BUILD_LOG.md with actual hours per block. 'Planned 40 h, took N h, cut X' is a strong interview artifact.

**2. Product / tenancy / 'Enterprise' label**

- **Problem:** The use case is internal company documents that every employee needs, but the tenant is a single user. Every employee would have to upload the same handbook. Nothing else is 'enterprise' either: no SSO, RBAC beyond admin, audit log, workspaces or HA. The same choice also caps the response-cache hit rate at near zero, because cross-employee repeats are exactly where caching pays.
- **Fix:** Keep the per-user decision for v1, but make it cheap to change:
- Key every tenant table by `tenant_id` (= Cognito sub in v1), plus a `workspaces` / `workspace_members` table with one workspace per user. Moving to shared workspaces then needs a data migration, not a code rewrite.
- Rename the project to 'Production-grade RAG with measured cost controls', or add a PRD section 'What enterprise would add': Cognito SAML/OIDC federation, workspace RBAC, audit log, multi-AZ, EU residency.
- Prepare the answer: 'enterprise' refers to the production mechanisms, not the feature set.

**3. Cost story / measurement validity**

- **Problem:** 1) The naive baseline (effort medium, implicit caching, k=8, no gate) is a strawman, and most of the gap is one parameter (reasoning effort), so the headline percentage overstates the engineering.
2) In the synthetic replay the repeat ratio (e.g. 20%) is chosen by the author, so the cache hit rate is an input, not a result.
3) In absolute terms, demo LLM spend (about $2.5/month) is dwarfed by AWS (about $21.6/month at list price). An interviewer will ask why you optimized cents.
- **Fix:** - Report two baselines: 'naive defaults', and 'sensible hand-tuned' (effort none, explicit_none, k=5).
- Add a leave-one-out delta per lever, with the quality delta (faithfulness, Recall) next to the dollar delta.
- Present cache savings as a curve over repeat ratio (0/10/20/40%) and say the organic hit rate is unknown.
- Always show absolute $ next to %. Add a TCO line: at about $0.0004/query, LLM spend overtakes infra above about 54k queries/month. That frames the levers as unit economics at scale ($ per 1M queries), which is the honest pitch.

### Major (12)

**1. Prompt caching arithmetic (D10, §7)**

- **Problem:** The plan's numbers do not reconcile.
- Fully warm, 1,024 cached tokens save 1024 × ($0.10 − $0.01)/1M ≈ $0.000092, which is −20% ($0.000363), not the −11% labelled 'warm'. −11% corresponds to about a 64% hit rate, with cold writes at 1.25×.
- +17% for implicit mode assumes every request writes about 3,040 tokens with zero partial-prefix hits, which is unverified.
- Padding the static prefix to 1,024 tokens with few-shots beats a 300-token uncached prompt only when the hit rate is at least about 83%. Against the same prefix uncached, break-even is about 22%.
- **Fix:** Write ADR-011 with the formula, prefix size and hit-rate parameter, and plot cost against hit rate. Report the measured Σcached/Σinput from the ledger. Add a 'short prompt, no cache' arm to the sweep. Justify the few-shot examples by their eval quality gain; caching only makes them cheap, it is not a saving by itself. Rename the 'warm' row to state its hit-rate assumption.

**2. Hybrid retrieval / gate (D8, D9)**

- **Problem:** `websearch_to_tsquery` joins unquoted terms with & (AND), as the Postgres docs state. A 10-word natural-language question often returns zero keyword rows, so the hybrid search is effectively vector-only. The gate condition 'no keyword hit' is then almost always true, so the gate is really cosine-only. `ts_rank_cd` is cover density with no IDF, yet the column is named `bm25_rank`; an IR-literate interviewer will pounce.
- **Fix:** - Build an OR query from lexemes: strip stopwords, then `to_tsquery('english', 'a | b | c')`, or rewrite `plainto_tsquery` output with | in place of &.
- Log the keyword branch's non-empty rate.
- Rename the column to `fts_rank`.
- Gate on calibrated cosine, optionally combined with at least 2 matched non-stopword lexemes. With OR semantics, 'any keyword hit' would almost never let the gate fire.
- Ablate hybrid on/off with a paired bootstrap, and expect gains mainly on identifiers (section numbers, form codes).

**3. Service split justification (ADR-002)**

- **Problem:** The thin stack (D2) uses nothing Python-only at serve time: the openai SDK, text splitters (@langchain/textsplitters), PDF parsing (pdfjs/unpdf) and pg all exist in TypeScript. 'Python where the AI ecosystem is' therefore sounds hollow, while the costs are real: two toolchains, a schema-contract test, an internal auth hop, an SSE proxy hop, and about 768 MB of RAM for two Python containers on a 2 GiB box.
- **Fix:** Rewrite ADR-002 around the real reasons:
(1) Eval parity. The Python harness (RAGAS/DeepEval) imports the exact retrieve/context/prompt code in-process, so the README numbers describe the production code.
(2) The ingestion roadmap: OCR, layout parsers, cross-encoder rerankers.
(3) Independent scaling of CPU-heavy ingestion (ai-worker).
List the costs explicitly, measure the extra hop's latency, and state the reversal condition, e.g. 'if eval moved out, fold chat into NestJS and keep only the worker in Python'.

**4. Eval validity (§8)**

- **Problem:** - Golden questions generated by RAGAS with the same model family paraphrase the chunks, which inflates Recall.
- The judge (Luna) grading the generator (Luna) invites self-preference bias.
- n≈60 gives ±9–10 pp, so most sweep deltas will be inconclusive.
- 0/5 injection canaries is statistically meaningless.
- RAGAS 0.4.3 dates from 2026-01-13, eight months before GPT-6, which raises breakage risk.
- **Fix:** - Split the retrieval set (150–300 questions): it needs no LLM to score, so it is cheap and narrows the CIs.
- Add 15–20 hand-written 'messy real user' questions and report them as their own slice.
- Move judge calibration (30 human labels, Cohen's κ) from stretch into W2, or use a judge from a different model family.
- Use 30–50 injection variants via promptfoo and report a rate with a CI.
- Pre-register which deltas you will claim, and publish the inconclusive ones.

**5. Citation metric**

- **Problem:** `citation_validity` only checks that each [n] is in 1..k, so it is almost always 1.0 and says nothing about whether the cited chunk supports the claim. An interviewer will call it a vanity metric.
- **Fix:** Add citation support (precision):
- For single-hop golden items: the share of cited chunks that overlap the gold (doc, page, quote). This is deterministic.
- On a sample: a judge or NLI check that each cited sentence is entailed by its chunk.
Keep validity as a sanity check only.

**6. CI determinism**

- **Problem:** Tier-1 CI gates call live OpenAI. Refusal accuracy, citation_validity == 1.0 and injection success depend on non-deterministic generation, even at temperature 0, and every run re-embeds. PRs will fail randomly and cost money; interviewers will ask 'is your gate flaky by design?'
- **Fix:** CI hard-gates only deterministic parts:
- Parsers and the cost formula.
- Retrieval metrics over a committed fixture of corpus and query embeddings (no API calls).
Generation metrics run on recorded responses (VCR-style) or nightly/on a label, compared with tolerance bands against results/main.json rather than hard equalities.

**7. Consistency / idempotency (chat flow)**

- **Problem:** Python writes `rag_requests`, `llm_calls` and the cache entry, while NestJS writes the assistant message only on `done`. If NestJS restarts mid-stream (including during a deploy), the cost is recorded but the message is lost. POST /messages has no idempotency, so a client retry after a network blip double-charges.
- **Fix:** - NestJS inserts the assistant message with status=streaming and the pre-generated assistantMessageId before calling Python.
- The finalizer updates it by id; a sweeper marks streaming messages older than 2 minutes as error.
- Accept a client-generated message UUID or an Idempotency-Key with a unique constraint.
- Document the invariant 'every llm_calls chat row has a message row' and test it.

**8. Budget reservation SQL (§7)**

- **Problem:** The reservation is a conditional `UPDATE user_daily_usage ... WHERE spent + reserved + est <= limit`, and 0 rows means 429. The first request of each Bratislava day has no row yet, so it returns 429. The user-cap and app-cap checks are also separate statements that can partially apply.
- **Fix:** Use `INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET reserved_usd = reserved_usd + $est WHERE ... RETURNING` for both rows in one transaction, and roll back if either returns nothing. Add tests for the first request of the day, the midnight/DST rollover, and 10 parallel requests.

**9. Operations: RPO/RTO, SLOs, deploys**

- **Problem:** - RPO/RTO are not stated. Nightly pg_dump plus daily DLM snapshots means RPO up to 24 h.
- `compose up --wait` recreates containers, which kills in-flight SSE streams and briefly returns 502s.
- There are no SLOs.
- There is no alarm on t4g CPU credits, although burstable throttling during ingestion plus Postgres is a real failure mode.
- **Fix:** - State RPO ≤ 24 h, and the RTO as measured in the restore drill. Put WAL archiving (wal-g/pgBackRest to S3) in stretch for an RPO of minutes.
- Add `stop_grace_period: 30s`, NestJS `enableShutdownHooks()` that drains streams, and a Python graceful shutdown.
- Define 3 SLOs with alarms: health-check availability, p95 TTFT, 5xx/error-event rate.
- Add a CPUCreditBalance alarm and a swap-in alarm.

**10. Failure handling: LLM provider**

- **Problem:** The fallback (gpt-5.6-luna) is the same vendor, so an OpenAI outage takes out both. There is no circuit breaker and no degraded mode, and 'What happens when OpenAI is down?' is a near-certain question.
- **Fix:** Add a circuit breaker (e.g. 5 failures in 60 s opens it for 30 s). When open, degrade to retrieval-only mode: stream the `sources` with snippets and 'Open PDF p. N' links under a banner, at zero LLM cost. Demo it live by blocking egress, and list per-stage timeouts in ARCHITECTURE.

**11. Capacity math (pgvector on t4g.small)**

- **Problem:** There are no numbers for how many chunks the box holds, or when HNSW is actually used. At demo scale (about 1k chunks) the planner will use the B-tree plus an exact sort, so 'HNSW with iterative scan' is never exercised. Highly selective tenant filters also run into `hnsw.max_scan_tuples` (default 20,000), which silently cuts recall.
- **Fix:** Add a capacity table to ARCHITECTURE:
- halfvec(1536) = 3,080 B; HNSW about 3.3–3.5 KB per vector (estimate, measure with `pg_relation_size`).
- About 50k chunks fit in memory on the t4g.small.
- About 1M chunks is roughly 8–9 GB total, which needs a DB host with 16 GB or more.
Capture EXPLAIN ANALYZE at 1k and 50k synthetic chunks, and state the switch points: partition by tenant, or move to a dedicated engine, above about 10M vectors or at p95 retrieval over 100 ms.

**12. Savings attribution (gate)**

- **Problem:** `cost_savings(no_answer_gate)` uses the 7-day median cost of all generations as its baseline. An abstention would have been short (about 30 output tokens): about $0.00032 against $0.000455 for an answered query, so the attributed savings are inflated by about 40%.
- **Fix:** Use the median cost of `no_answer_model` requests as the gate baseline. Label every dashboard figure as either 'estimated counterfactual' or 'replay-measured', and never add the two together.

### Minor (7)

**1. Cost reconciliation**

- **Problem:** The ±2% dollar reconciliation against the OpenAI dashboard is not feasible at demo spend: about $0.08/day, while the dashboard shows cents, so 2% is below display resolution.
- **Fix:** Reconcile token counts per model per day via the Usage API, and reconcile dollars only over the replay window (≥ $1 spend).

**2. CloudFront flat-rate Free constraints**

- **Problem:** Verified limits:
- 5 WAF rules in total (the plan uses 4: Common, KnownBadInputs, IpReputation, rate), so there is no headroom.
- No custom response-header policies: CSP only via `<meta>`, which cannot set frame-ancestors or report-to.
- No VPC origins (Business tier and up), so the EC2 origin must be public.
- Accounts on AWS Free Tier are not eligible, and the Web ACL cannot be detached.
- **Fix:** Record the 5-rule budget in ADR-022. Rely on the managed SECURITY_HEADERS policy for X-Frame-Options. Prepare 'why is the origin public?': egress to OpenAI, ECR, JWKS and Langfuse needs a public IPv4 or a NAT (about $30+/month) anyway, VPC origins would need a paid tier, and the SG prefix list, secret header, WAF and JWT form the layered compromise.

**3. Model reproducibility**

- **Problem:** gpt-6-luna is an undated alias, so behavior can change silently between eval runs. The plan's `temperature=0` ('allowed only at effort none') is not confirmed in the model docs.
- **Fix:** Store the returned `response.model` and the service tier on every llm_calls row and eval result. Run a small nightly smoke eval to detect drift. Verify on day 1 that temperature is accepted, and drop it if not.

**4. Data residency**

- **Problem:** For a Slovak company's HR documents, the first legal question is where the data goes. EU residency (+10%) works only with Standard processing, so it conflicts with the Flex judge, and chunk text also goes to Langfuse.
- **Fix:** Document the matrix. Prod: EU residency switch, `store:false`, Langfuse masking on by default. Eval: public corpus, Flex allowed. Name the 'data must stay in AWS' alternative (Bedrock, evaluated with the same harness).

**5. Observability duplication**

- **Problem:** Langfuse, a custom Ops dashboard and Postgres telemetry overlap and cost about 4 h in W2. The replay on prod can also burn Langfuse Hobby's 50k units (6–8 units per turn), and Hobby sells no overage.
- **Fix:** Limit the dashboard to ledger-backed business metrics: $/query, savings waterfall, cache hit %, no-answer %, thumbs. Leave traces to Langfuse. Disable or sample tracing during the replay, as well as during eval sweeps.

**6. Testing gaps**

- **Problem:** There is no load test to back the t4g.small sizing claims, no browser e2e, and no fault injection for OpenAI failure modes (429, 500, slow stream, mid-stream disconnect).
- **Fix:** - k6 with N concurrent SSE streams: record the maximum concurrency before p95 TTFT exceeds 3 s, plus `docker stats` output.
- A fake OpenAI server via OPENAI_BASE_URL for deterministic fault tests.
- One Playwright happy path (login with a Cognito test user, upload, ask, see a citation).
Put these numbers in ARCHITECTURE.

**7. Scale hot spots**

- **Problem:** The ledger trigger updates one `app_daily_usage` row on every LLM call, and reservations hit the same row, which serializes at scale. The throttler is in-memory, so it is per-process. A JWT stays valid for up to 1 h after GlobalSignOut.
- **Fix:** Mention these in the 100× answer: sharded counters or periodic aggregation, throttler storage in Redis, and a shorter access-token TTL or a revocation check for admin actions.


## Likely interview questions (15)

**Q1. You deliberately avoided LangChain and LlamaIndex, and the openai SDK, text splitters and PDF parsing all exist in TypeScript. Why a separate Python service at all?**

Not for a framework. I chose a thin stack so hybrid search, caching and cost accounting stay visible.

Three reasons:
1. **Eval parity.** The Python harness (RAGAS/DeepEval) imports the exact retrieve, context and prompt code in-process, so the README numbers describe the production pipeline, not a reimplementation.
2. **Ingestion roadmap.** OCR, layout-aware parsing and cross-encoder rerankers live in Python.
3. **Independent scaling.** CPU-heavy ingestion runs in its own ai-worker container.

Costs I accepted:
- two toolchains;
- a schema-contract test, because Drizzle owns the DDL;
- an internal-token hop of a few milliseconds on the compose network;
- about 770 MB of RAM for two Python containers on a 2 GiB box.

If eval parity stopped mattering, I would fold chat into NestJS and keep only the worker in Python.

**Q2. Why pgvector instead of Pinecone, Qdrant or another dedicated vector DB? Does your HNSW index even get used?**

One Postgres gives me:
- one transaction for chunks, documents, cache invalidation and the cost ledger, so deleting a document removes its vectors immediately;
- hybrid search in one SQL query;
- tenant filters as plain WHERE clauses;
- one backup.

Capacity:
- halfvec(1536) is 3,080 bytes, and HNSW adds roughly 3.3 KB per chunk.
- About 50k chunks stay in memory on the t4g.small.
- About 1M chunks is roughly 8–9 GB, which needs a DB host with 16 GB or more. That is still normal pgvector territory.

At demo scale the planner picks the (user_id, document_id) B-tree plus an exact sort, which gives 100% recall. I have EXPLAIN ANALYZE at 1k and 50k chunks showing the switch to HNSW with iterative scan.

When I'd switch: very selective tenant filters hit hnsw.max_scan_tuples (default 20k) and recall drops. So my triggers are about 10M vectors, or p95 retrieval over 100 ms: first partition by tenant, then consider a dedicated engine with native filtered search.

**Q3. Why a single EC2 instance instead of ECS/Fargate? What are your RPO and RTO, and what happens during a deploy?**

High availability is an explicit non-goal, so I optimized for cost and simplicity.
- The t4g.small costs $0 under the T4g trial until 2026-12-31 ($14/month list).
- Fargate needs an ALB (roughly $18–20/month before LCUs), task costs and managed Postgres: about 3–4× for a handful of users.
- Everything is containerized and in CDK, so moving to ECS means a new Compute stack, not a rewrite.

What I own:
- **RPO:** up to 24 h (nightly pg_dump to S3 plus daily EBS snapshots). WAL archiving is the next step.
- **RTO:** the time measured in my restore drill.
- **Deploys:** a few seconds of 502s. Graceful shutdown with a stop grace period drains streams.

Alarms cover memory, disk, CPU credits and the Route 53 health check. Rollback means redeploying the previous SHA, which I have exercised.

**Q4. What makes this 'enterprise'? Your tenant is a single user. How would 500 employees share the HR handbook?**

Fair point: 'enterprise' describes the production mechanisms, not the feature set. Those mechanisms are:
- invite-only Cognito;
- tenant isolation tested at three layers;
- a cost ledger with hard budgets;
- eval gates in CI;
- infrastructure as code and keyless CI/CD.

Gaps I state up front: no shared workspaces, no SSO federation, no RBAC beyond admin, no audit log, single AZ.

The schema keys everything by tenant_id, so workspaces need only a membership table and a data migration. An admin then uploads the handbook once and everyone queries it. That is also when response caching really pays, because employees repeat each other's questions. Cognito already supports SAML/OIDC federation for SSO.

**Q5. How do you know the answers are actually good?**

Three layers.

**Offline golden set.**
- About 60 human-verified items, anchored to (document, page, evidence quote) rather than chunk IDs.
- Slices: single-hop, multi-hop, unanswerable, cross-tenant, injection, follow-up.
- A bigger retrieval-only set narrows the confidence intervals, because it needs no LLM to score.

**Metrics.**
- Deterministic metrics gate CI: Recall@5, MRR, refusal accuracy, false refusals, and citation support (is the cited chunk the gold evidence?).
- RAGAS faithfulness and relevancy use a judge on Flex and stay report-only until calibrated against my labels on 30 items (Cohen's κ).
- With n≈60 the CI is about ±10 pp, so I claim only deltas whose paired-bootstrap CI excludes zero, and I list the inconclusive ones.

**Online signals.**
- Thumbs plus reasons, no-answer rate, and top-1 score against thumbs-down rate (this justifies τ).
- Every thumbs-down links to a Langfuse trace.

Caveats: a synthetic-heavy set, a same-family judge, and an English corpus.

**Q6. How exactly did you measure the savings? Isn't your naive baseline a strawman?**

There are two measurement sources.
- **The ledger.** Every OpenAI call is a row, priced from a versioned price table using the usage fields the API returns, and reconciled with OpenAI's token usage.
- **The A/B replay.** The same scripted traffic runs under each config, and I compare billed $/1k from the ledger.

I report against two baselines: naive defaults (effort medium, implicit caching, k=8, no gate), and a sensible hand-tuned config (effort none, no caching, k=5). Each lever also gets a leave-one-out delta with its quality delta next to it.

I say it openly: most of the naive gap is reasoning effort. That is a finding (a default silently bills reasoning tokens), not engineering.

Cache savings are a curve over repeat ratio, because in synthetic replay I choose the repeat ratio.

In absolute terms, demo LLM spend is about $2.5/month against about $22 of AWS. LLM spend overtakes infra above about 54k queries/month, which is where these levers matter, so I quote $ per 1M queries.

**Q7. Explain explicit versus implicit prompt caching and your +17% claim. Did padding the prompt to 1,024 tokens actually save money?**

On GPT-5.6 and later, cache writes cost 1.25× input and cached reads cost 0.1×.

**Implicit mode** puts the breakpoint at the end of the latest message. In RAG that is the documents-plus-question block, which never repeats. In the worst case every request writes about 3k tokens and never reads them back: +17%.

**Explicit mode** puts one breakpoint after a byte-identical static prefix of at least 1,024 tokens.
- Against the same prefix uncached, it breaks even at about a 22% hit rate.
- Fully warm, it saves about 20%. My −11% figure corresponds to about 64% hits.

The honest part: against a 300-token prompt with no caching, padding to 1,024 tokens only wins above about 83% hits. So I justify the few-shot examples by their eval quality gain, and caching simply makes them cheap. The measured hit rate is Σcached/Σinput from the ledger.

**Q8. Semantic caching can serve a confidently wrong answer. How did you choose 0.95, and is your hit rate meaningful?**

The exact tier is safe. Its key is user plus scope_hash, which covers prompt version, model, retrieval config and each document's SHA-256. Any document change misses, and a test proves it.

The semantic tier is risky: 'sick leave for part-time staff' and 'for full-time staff' can exceed 0.95 cosine. So:
- I measured the false-hit rate on 20 paraphrase pairs and 20 near-miss pairs.
- I enable the tier only if false hits are at most 1–2%.
- Otherwise I ship it off and publish the negative result.
- Cached answers carry a badge and a Regenerate button.

On hit rate: with per-user scope, the organic hit rate is near zero. The replay hit rate reflects the repeat ratio I chose, so I show it as a curve. The economics only become interesting with workspace-level scope.

**Q9. Someone uploads a PDF with hidden text saying 'ignore previous instructions'. What happens?**

This is indirect injection (OWASP LLM01), and the design bounds its impact.
- There are no tools and no agent actions.
- Output goes through react-markdown without raw HTML, links are allowlisted to our own origin, and remote images are not rendered. That closes the usual exfiltration channels.
- Documents are tenant-scoped, so the worst outcome is a manipulated answer shown to the uploader.

Controls:
- Chunks are wrapped in <document> tags under an 'untrusted data' rule.
- Ingestion heuristics flag instruction phrases, template tokens, zero-width or bidi characters, and base64 blobs. Flagged chunks get a badge and can optionally be dropped from context.
- Planted canary documents measure the success rate in the eval.

I report a rate with a confidence interval, not '0/5 means safe', and I extend the set with promptfoo variants.

**Q10. How do you guarantee one user never sees another user's data, even if a developer forgets a WHERE clause?**

Identity is the Cognito sub from a verified access token. I never key on email, and ID tokens are rejected.

Three layers:
1. **NestJS.** Every repository method takes userId, and resources the user doesn't own return 404, not 403.
2. **Python.** NestJS resolves the allowed documentIds, and Python still filters every SQL query by user_id AND document_id = ANY(...).
3. **Postgres.** Least-privilege roles, plus RLS on chunks and the semantic cache via SET LOCAL app.user_id, so a forgotten WHERE clause returns zero rows.

Other controls:
- Cache keys include user_id.
- OpenAI's prompt cache holds only the static, non-user prefix.
- S3 keys are built on the server under users/{sub}/.

Proof:
- Two-user e2e tests: user B gets 404 on A's documents, conversations and documentIds.
- A cross-tenant eval slice.
- A 100-probe script reporting 0 cross-tenant retrievals.

**Q11. What happens when OpenAI is down, slow, or fails in the middle of a stream?**

Before streaming: the budget reservation and validation happen before the SSE headers, so early failures return proper problem+json errors.

During a request:
- The SDK retries twice, and every stage has its own timeout.
- A mid-stream failure emits an `error` event with a `retryable` flag.
- The partial message is saved with status error, and the ledger records estimated usage.
- A client abort propagates through AbortController and closes the OpenAI stream.

Outages: the fallback model is a config switch, but it is the same vendor. So a circuit breaker degrades to retrieval-only mode, which shows the top sources with snippets and page links under a banner. It costs nothing in LLM spend and is still useful.

Ingestion jobs retry with exponential backoff up to 3 attempts. Leases let another worker reclaim a job if the worker crashes.

**Q12. What happens at 100× scale? What breaks first?**

Say 100× means about 300 users, 600k queries/month and 600k chunks.

**LLM cost and limits.**
- About $240/month at $0.0004/query.
- OpenAI Tier 1 (500K TPM) covers about 160 queries/min at 3k tokens each.
- Bulk re-embedding goes through Batch.

**What breaks, in order:**
1. **RAM.** 600k chunks with HNSW is about 5 GB, so Postgres moves to its own host or RDS with 16 GB or more.
2. **The single instance.** api and ai become ECS services behind an ALB across two AZs. Throttler state moves to Redis, and SSE streams need a graceful drain.
3. **The queue.** SKIP LOCKED holds up to thousands of jobs per minute; SQS comes in when workers need to autoscale on queue depth.
4. **The ledger.** The single app_daily_usage row becomes a hot row, so it needs sharded counters.
5. **Observability.** Langfuse Hobby's 50k units cover about 6k turns, so I'd pay or sample.

On the product side: workspaces and SSO.

**Q13. Walk me through your hybrid search. How did you verify it helps?**

It is one SQL query:
- semantic top-40 over halfvec with an iterative HNSW scan;
- keyword top-40 via Postgres full-text search;
- a FULL OUTER JOIN, then Reciprocal Rank Fusion with k=60;
- then dedup by content hash and a 2,000-token context budget.

Two gotchas:
1. websearch_to_tsquery ANDs every term, so natural-language questions often returned zero keyword rows. I now build an OR query from lexemes and log the keyword branch's non-empty rate.
2. ts_rank_cd is not BM25 (it uses no IDF), so I call it FTS rank.

Verification: a hybrid on/off ablation on Recall@5 and MRR with a paired bootstrap. The gains come mainly on exact identifiers such as section numbers and form codes.

Limitation: the FTS config is 'english', so Slovak documents get semantic-only retrieval.

**Q14. How do you stop a user, or a bug, from burning your OpenAI budget? What about race conditions?**

Layers:
- a per-user daily cap (default $0.25, about 600 queries);
- a global daily cap of $2;
- OpenAI project hard limits (prod $20/month);
- a throttler (30 chats/min) and a WAF rate rule;
- invite-only sign-up.

Race conditions:
- The reservation is one conditional upsert. It reserves input estimate + max_output_tokens × output price (about $0.0007), and only if spent + reserved + estimate stays within the limit.
- Ten parallel requests overshoot by at most one reservation; I tested it with xargs -P10.
- Actual spend arrives through an AFTER INSERT trigger on llm_calls, so usage cannot drift from the ledger.
- Reservations are released in a finally block, and a leaked one clears itself at the Bratislava-midnight day boundary.

The 429 response is problem+json with Retry-After.

**Q15. Why build on gpt-6-luna, a model a few days old with no dated snapshot? How are your results reproducible?**

Price and lifecycle. Luna costs $0.10 input, $0.01 cached and $0.50 output per 1M tokens, and it has no shutdown date. The cheaper options are being retired: gpt-5-nano shuts down on 2026-12-11 and gpt-4.1-nano on 2026-10-23.

The risks are an undated alias and vendor-only quality claims. Mitigations:
- The model is config, and the config hash goes onto every rag_requests row and every eval result.
- Every result is stamped with date, git SHA, dataset version and the returned response.model.
- A nightly smoke eval catches drift, and I re-run the golden set before each interview.
- The sweep compares Luna with gpt-5.4-nano and gpt-5.4-mini on the same set, and gpt-5.6-luna is a one-line fallback.

If the data had to stay inside AWS, the same harness would decide whether Bedrock is acceptable.
