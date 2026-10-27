# SmartDoc AI: interview notes

How to present the project and answer the questions it invites. Every number here is measured and
traceable to [BUILD_LOG.md](BUILD_LOG.md), an ADR or a committed result file. Numbers from runs on
the unreviewed golden set are marked **dry run**.

## Caveats, said first

- **Not deployed.** It runs locally against real dev Cognito and S3. The production design is
  written and its riskiest part (SSE through CloudFront and Lambda) is proven by a spike, but I
  chose not to pay for an idle demo ([deploy-prod.md](runbooks/deploy-prod.md)).
- **Quality numbers are preliminary.** The golden set (40 items) waits for my review, so its
  figures are a dry run. The relevance gate is not calibrated yet: it refused 0 of 7 unanswerable
  questions.
- **Small samples.** 12 injection canaries with 0 successes still allow up to 24 % (Wilson 95 %).
- **The cost replay is synthetic traffic** (238 questions per arm, 20 % exact repeats), labelled as
  such.

## 60-second pitch

SmartDoc lets employees ask questions about company PDFs and get answers that cite the page,
streamed in about a second and a half. It says "not in the documents" instead of guessing.

What makes it more than a RAG demo is that its two claims are measured:
- **Cost:** every OpenAI call is a priced ledger row. A replay of the same traffic through three
  configurations shows the optimized one at **$0.20 per 1,000 queries against $0.46 for naive
  defaults**, with each saving attributed to a mechanism. Per-user daily budgets with reservations
  hold under concurrency.
- **Quality:** an eval harness runs a deterministic retrieval tier on every pull request for $0,
  with 100 cross-tenant probes, and a live tier with citations, refusals and injection canaries.
  The claims were pre-registered before the first official run.

The stack: React and NestJS in TypeScript, a Python FastAPI service for the RAG pipeline, Postgres
with pgvector for everything, OpenAI, and Cognito and S3 provisioned with CDK.

## 5-minute walk-through

1. **Upload:**
   - the browser hashes the file and POSTs it straight to S3, which enforces the checksum;
   - the API validates what landed (size, `%PDF-`, the exact version) and queues a job in the same
     transaction;
   - a worker parses the PDF in a resource-limited child process, then chunks, embeds and finalizes
     with a fenced transaction.
2. **Ask:**
   - the API checks ownership, reserves budget, pre-inserts the answer row and streams `ack`;
   - the AI service re-checks scope, rewrites follow-ups, tries the exact cache, then runs one SQL
     query: HNSW and full text fused with RRF;
   - a relevance gate can refuse without an LLM call;
   - the prompt keeps a static, cacheable prefix;
   - the answer streams back through the API, which persists it and releases the reservation.
3. **Account:** a ledger row per call, priced by a trigger from a versioned price table. The Cost
   page reads only the ledger.
4. **Prove it:**
   - the IDOR test is generated from the routes Express mounts;
   - the eval runs in CI from a committed fixture;
   - the OpenAPI spec is tested against the mounted routes;
   - a restore drill verifies every table.

Diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).

## Questions and answers

**1. Why a separate Python service when the SDK, splitters and PDF parsing exist in TypeScript?**

- The eval harness and the pipeline must be the same code. The harness ingests the corpus through
  the real worker and runs the real chat pipeline, which is where Python's eval and data tooling
  is.
- The API owns identity, tenancy and money; the AI service owns retrieval and generation.
- **What it costs:** two toolchains, a contract (zod, plus a JSON Schema for Python) and an internal
  hop, measured at **≈ 60 ms** ([ADR-001](adr/001-service-split.md), [ADR-007](adr/007-streaming.md)).
- **Reversal:** if eval moved out, I would fold chat into NestJS.

**2. Why pgvector and not a vector database? Does the HNSW index even get used?**

- One transaction covers a document, its chunks and its job; tenant scope is a `WHERE` in the same
  query; there is one backup.
- **Measured:** 11.9 KB per chunk in total (HNSW 4.1 KB per vector); retrieval p50 18.8 ms, p95
  64 ms over 190 questions.
- **Honestly, at 1,002 chunks the planner does not use HNSW:** a sequential scan is exact and
  cheaper there. The open measurement is EXPLAIN at 50k chunks.
- **Switch points:** ≈ 10M vectors, or retrieval p95 above 100 ms
  ([ADR-002](adr/002-pgvector-single-store.md)).

**3. What makes this enterprise-grade when a tenant is one user?**

- **The isolation machinery is real:**
  - the tenant from the token's `sub` in every query;
  - 404 for foreign ids;
  - an IDOR test generated from the mounted routes;
  - a scope re-check in the AI service;
  - 0 of 100 cross-tenant retrieval probes.
- **Proof the test bites:** removing the tenant filter from one repository method made it fail
  immediately.
- **Missing for an enterprise:** workspaces with roles, federation, an audit log, row-level
  security. All are listed in the [PRD](PRD.md).

**4. How did you measure savings? Isn't "naive" a strawman?**

- **Method:** the same 238 questions through three configurations, costed from the ledger rows of
  each arm's requests.

  | Arm | $ per 1k queries |
  |---|---|
  | Naive | $0.46 |
  | Sensible | $0.36 |
  | Optimized | $0.20 |

- **Not a strawman:** the naive arm already had a 44 % prompt-cache share through implicit caching.
  Most of its extra cost is 28k reasoning tokens billed at the output rate.
- **Attribution per 1k queries:**

  | Mechanism | Saving |
  |---|---|
  | No reasoning | $0.105 |
  | Prompt cache | $0.095 |
  | Exact cache | $0.041 |
  | Unexplained remainder | $0.018 |

- **The trade-off:** without reasoning the model declined 50 of 238 questions instead of 24, a
  quality question the eval has to answer.
- **TCO:** with AWS at ≈ $10–14 a month, LLM spend overtakes infrastructure at ≈ 50–70k queries a
  month.

**5. Explicit prompt caching: did it pay?**

- **The prompt layout:** a static 1,264-token prefix (rules and few-shot examples) with one cache
  breakpoint.
- **Measured:** a warm call costs $0.000056 against $0.000206 for the call that writes the cache,
  73 % less for this prompt shape.
- **In the replay,** the prompt cache saved $0.095 per 1,000 queries, net of the write premium
  ([ADR-004](adr/004-prompt-caching.md)).

**6. Walk me through hybrid search. How do you know it helps?**

- **The query:**
  - a vector branch and a keyword branch (OR over the question's lexemes), 40 candidates each;
  - fused with RRF (k = 60), ties broken by id;
  - the gate reads the best cosine score and the number of matched lexemes.
- **Evidence:** claim C1 in `eval/claims.yaml` (hybrid beats vector-only on golden Recall@5) is
  pre-registered and tested once in the 2.7 sweeps with a paired bootstrap.
- **Why it matters for law:** section numbers and defined terms are exactly what embeddings blur.

**7. How do you know the answers are good?**

- **Two tiers:**
  - deterministic retrieval metrics in CI, from a fixture;
  - a live tier with citation precision, refusal accuracy and injection canaries.
- **Dry run:** Hit@5 0.83, MRR 0.54, citation precision 0.82, injections 0 of 12.
- **The dry run caught a real bug:** retrieval ranks depended on physical row order, so a restored
  database scored differently until ties were broken by id.
- **Not trusted on their own:** an LLM judge only after it agrees with 20 human labels
  ([ADR-010](adr/010-eval-strategy.md)).

**8. How do you guarantee user A never sees user B's data, even through caches, a forgotten
`WHERE` or a compromised AI service?**

- **Query layer:** every query is scoped by the tenant, and the IDOR test covers every `:id` route.
- **Cache:** keyed by tenant, the document scope hash and the normalized question.
- **Retrieval:** the AI service re-verifies that the requested documents belong to the tenant
  before retrieval.
- **Credentials:** the AI service has no AWS credentials at all. It downloads through a 5-minute
  presigned URL that the API issues for one object version.
- **Not there yet:** row-level security would be the next line.

**9. Someone uploads a malicious PDF. What happens?**

- **At upload:**
  - the POST policy bounds size and type, and S3 checks the checksum;
  - the API checks the magic bytes on the pinned version.
- **At parse:** parsing runs in a child process with CPU, memory and page limits. Permanent
  failures (no text layer, encrypted, too many pages) stop at once with a specific code.
- **Injected instructions:**
  - the document text is delimited and escaped, with an "untrusted data" rule;
  - the markdown renderer allows no HTML, no images and no external links;
  - 12 canaries across 4 classes: 0 succeeded in the dry run.

**10. How do you stop a user, or a bug, from burning the budget? Is it correct under
concurrency?**

- **Reservation:** one READ COMMITTED transaction makes conditional UPDATEs on the user's daily row
  and the app's daily row, then inserts a reservation.
- **Measured:** 10 parallel requests against a limit with room for 3 accepted exactly 3. A naive
  check-then-act version accepted all 10 (2.8× the limit).
- **Release:** idempotent and pinned to the stored day. A sweeper frees reservations of requests
  that died. Over the limit, the API answers 429 with `Retry-After`
  ([ADR-008](adr/008-cost-ledger.md)).

**11. How would you run it in production? RPO, RTO, deploys?**

- **Design:** Lambda in a VPC with a NAT instance, Aurora Serverless v2 that pauses when idle,
  CloudFront, and `cdk deploy` through GitHub OIDC after green CI. It costs ≈ $10–14 a month.
- **Why not the Data API that my other projects use:** it would mean rewriting the DB layer in two
  languages.
- **Proven:** 90-second SSE streams through CloudFront and two Function URLs, without buffering.
- **Gotcha found:** new Function URLs need `lambda:InvokeFunction` as well as
  `lambda:InvokeFunctionUrl`.
- **RPO/RTO:** RPO 5 minutes (Aurora point-in-time recovery). The local restore drill measured an
  RTO of 8–11 s, with every table verified ([ADR-009](adr/009-compute-and-edge.md)).

**12. What happens when OpenAI is down, slow, or fails mid-stream?**

- **Timeouts per stage:** embed 5 s, rewrite 5 s, first token 20 s, answer 60 s.
- **Circuit breaker:** opens after 5 failures in 60 s, for 30 s.
- **Degraded answers:** before the first token, the user gets the most relevant passages without
  generation.
- **Mid-stream failure:** an `error` event with a retryable flag.
- **Lost client:** the upstream request is aborted, and the partial answer is stored as `aborted`.

## What broke along the way

- **Answer before question.** Both rows of a turn shared `created_at`, so history went to the model
  answer-first. A test caught it.
- **Retrieval depended on row order.** A restored database gave different eval numbers until ties
  were broken by id.
- **Budgets.** The first version released the reservation after the response ended and raced the
  client.
- **PDF parsing.** Ligatures ("ﬀ", 290 times in the Labour Code) and legal section headings needed
  parser fixes.
- **Function URLs.** Every call returned 403 until both invoke permissions were granted.
- **Restore.** `pg_restore` as the owner role failed on `COMMENT ON EXTENSION`. Extensions belong
  to the bootstrap, so the restore leaves them out.

## At 100× the traffic

- **Compute:** Lambda scales per request. Aurora scales in ACUs; at a steady load, a provisioned
  instance becomes cheaper.
- **Ingestion:** SQS-triggered workers instead of polling.
- **Retrieval:** at ≈ 600k chunks (≈ 7 GB), a dedicated database host; partition by tenant before
  considering a separate vector engine.
- **Cost:** a semantic cache tier, after measuring its false hits. Batch and flex service tiers for
  non-interactive work.
- **Spend:** the per-user budgets become per-workspace quotas.
