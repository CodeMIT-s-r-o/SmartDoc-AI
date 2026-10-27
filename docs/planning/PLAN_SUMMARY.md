# SmartDoc AI: Implementation Plan

## Context
SmartDoc AI is a greenfield portfolio project to defend in job interviews. It is a web app where invited users upload
company PDFs (manuals, policies) and chat with them. Answers are streamed, cite pages, and are scoped to the logged-in user.
The interview story rests on two pillars. Both must be **measured**, not claimed:
- **Cost controls:** $/1k queries across three replay arms, the savings from each mechanism, and live budget caps.
- **Quality monitoring:** a README eval table generated from committed results, with ablations.

Status: the plan as written on 2026-09-25, kept as it was. See [README.md](README.md) for what changed and where the
current documentation is.

**Fixed by the user (2026-09-25):**
- React/Vite and NestJS + Drizzle.
- A separate Python AI service (FastAPI).
- Postgres + pgvector.
- OpenAI.
- Cognito invite-only.
- S3.
- Docker, a single EC2 running Compose, the frontend on S3 + CloudFront, CDK in TS.
- **2 weekends.**
- Chat in Slovak; all code, comments and docs in English.

**How this plan was made:**
1. A 9-agent workflow researched LLM cost, the Python RAG stack, AWS infra, and eval/observability. It checked facts on the web as of 2026-09-25.
2. A lead architect drafted the plan.
3. Three reviewers attacked it: interviewer, security/correctness, and feasibility/cost. They raised 4 critical, 32 major and 22 minor issues.
4. The architect revised it. The v2 plan below is the condensed result.

**Where the detail lives:**
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): the full v2 plan (1,469 lines), including SQL, the SSE contract, request flows, the 40-row verification matrix and the 12-question interview Q&A.
- [planning/research/](research/): the four research reports, with sources.
- [planning/draft-plan-v1.md](draft-plan-v1.md): the pre-review draft.
- [planning/reviews/](reviews/): the three reviews, with issues, fixes and likely interview questions.

**Spot-checked personally:**
- `gpt-6-luna` exists at $0.10 input / $0.01 cached / $0.125 cache write / $0.50 output per 1M tokens, default effort medium. Batch and Flex cost −50%.
- `@nestjs/core` 12.1.0 is ESM-only.

## Key facts that shape the design
- **Model shutdowns.** gpt-4.1-nano shuts down 2026-10-23; gpt-5-nano and gpt-5-mini on 2026-12-11. So the default model is **gpt-6-luna**, with `effort:none`. Luna's default `medium` effort silently bills reasoning tokens at the output rate.
- **Prompt caching on GPT-5.6+.** Cache **writes cost 1.25× input**. Implicit caching of RAG prompts can raise cost by about 17%. Use one **explicit breakpoint** after a static prefix of at least 1,024 tokens; it breaks even at about a 22% hit rate.
- **Postgres FTS.** `websearch_to_tsquery` ANDs terms, so the keyword branch must build an **OR tsquery**. `ts_rank_cd` is not BM25; call it `fts_rank`.
- **Local AWS emulators.** MinIO CE was archived and LocalStack now needs a token. Use a **real dev S3 bucket and dev Cognito pool** locally.
- **Python version.** ragas 0.4.3 has no cp314 wheels. Use **Python 3.13** in the service and in eval; the host has 3.14 via asdf.
- **T4g trial.** t4g.small is free until 2026-12-31. CloudFront's flat-rate Free plan includes WAF, but accounts on the Free Tier plan are not eligible; check this in Block 0.

## Decision register (condensed)
| Area | Decision |
|---|---|
| Repo | Public GitHub monorepo, Yarn 4 workspaces + uv. Squash-merge PRs to `main` |
| AI framework | **Thin stack**: official `openai` SDK + `langchain-text-splitters` + raw SQL (psycopg 3 + pgvector-python). No LangChain or LlamaIndex chains or vector stores, because Drizzle owns the schema and the RAG internals are the part to show. RAGAS lives only in `eval/` |
| Chat model | `gpt-6-luna`, Responses API, `effort:none`, `verbosity:low`, `max_output_tokens:600`, `store:false`, no `temperature`. Fallback `gpt-5.6-luna` via config |
| Embeddings | `text-embedding-3-small` → `halfvec(1536)`, HNSW `halfvec_cosine_ops` |
| PDF | pypdf (BSD) in a resource-limited child process. Caps: ≤ 300 pages, ≤ 20 MB. No OCR |
| Chunking | Section-first, then 500 tokens / 75 overlap (cl100k). Page ranges kept per chunk for citations |
| Retrieval | Hybrid in one SQL query: HNSW top-40 + FTS top-40 (OR tsquery), fused with RRF k=60, then k=5 within a 2,000-token budget. Reranker off (stretch) |
| Abstain gate | Skip the LLM if `max_cos < 0.30` and matched lexemes < 2, both calibrated on eval. The model's `NO_ANSWER` sentinel is the second layer |
| Response cache | Exact tier only, keyed by `(tenant_id, scope_hash, question_hash)`. `scope_hash` covers the doc set + `ready_at` + prompt/model/config. Semantic cache is stretch |
| Jobs | Postgres queue: poll every 2 s, `FOR UPDATE SKIP LOCKED`, lease token, `attempts` set at claim, outbox with the document row. SQS is the scale path |
| Streaming | FastAPI SSE → NestJS raw `@Post` pass-through (one read loop) → React `fetch` + `eventsource-parser` |
| Cost ledger | One `llm_calls` row per billed call, in its own transaction. Versioned `model_prices`. A trigger updates daily usage. Budget **reservations** |
| Tracing | Langfuse Cloud Hobby EU, **Python only**. Postgres is the source of truth for money and quality aggregates |
| Eval | Python harness in-process. The CI gate uses **retrieval metrics on a committed fixture with zero API calls**. LLM and judge tiers run locally and their results JSON is committed |
| Auth | Cognito Essentials managed login, PKCE via `react-oidc-context`. NestJS verifies **access tokens** with `aws-jwt-verify` |
| Uploads | Presigned **POST** (enforces size and type), magic-byte check, S3 `VersionId` pinning |
| Tenancy | Every table is keyed by `tenant_id` (= Cognito `sub` in v1), so workspaces can come later |
| Failure mode | Circuit breaker → **degraded answer** (sources only, $0) |
| Compute/edge | t4g.small AL2023 + Compose + Caddy (Let's Encrypt), behind one CloudFront distribution: `/api/*` → EC2, default → S3. Same origin, so no CORS |
| Secrets/CI | SSM SecureString; GitHub OIDC → ECR (arm64) → custom SSM document `SmartDoc-Deploy(sha)` |
| Runtimes | Node 24 LTS images; NestJS 12 after a 20-minute ESM timebox, else 11.2.x; Python 3.13 |

## Architecture
```
Browser ─HTTPS─> CloudFront smartdoc.codemit.sk (WAF, flat-rate Free)
   │              ├─ default → S3 SPA (OAC, CSP via CF Function)
   │              └─ /api/*  → origin.smartdoc.codemit.sk (Caddy, X-Origin-Verify)
   │   EC2 t4g.small, Docker Compose:
   │     caddy → api (NestJS: JWT, tenancy, S3 presign, budgets, SSE proxy)
   │                 └─X-Internal-Token→ ai (FastAPI: scope check → cache → embed → hybrid SQL → gate → LLM → ledger)
   │             ai-worker (poll queue → sandboxed parse → chunk → embed → index)
   │             db (Postgres 18 + pgvector 0.8.6) on a separate EBS volume
   ├─ presigned POST/GET ─> S3 docs bucket (private, versioned)
   └─ OIDC + PKCE ─> Cognito managed login
ai/worker → OpenAI, Langfuse EU │ logs → CloudWatch → alarms │ GitHub Actions ─OIDC→ ECR → SSM deploy
```
Only `api` holds AWS credentials. Python gets presigned URLs from `api`, and IMDS is blocked for the Python containers.

## Repo layout
```
apps/web            React 19 + Vite 8 + TanStack Query + react-markdown (no raw HTML) + Recharts
apps/api            NestJS + Drizzle (schema, migrations incl. custom SQL, advisory-locked migrate)
services/ai         FastAPI + worker (uv, Python 3.13): rag/, ingest/, cost/, tools/replay.py, tests/
packages/contracts  SSE event zod schemas, generated OpenAPI types
eval/               uv project: corpus/, datasets/*.jsonl, fixtures/, thresholds.yaml, run_eval.py, report.py, results/
infra/cdk           Ci, Storage, Auth, Compute stacks (eu-central-1) + Edge stack (us-east-1)
deploy/             compose.prod.yml, Caddyfile, deploy.sh, render-env.sh, systemd timers
docs/               PRD, ARCHITECTURE, INTERVIEW, BUILD_LOG, IMPLEMENTATION_PLAN, sse-contract, adr/, runbooks/
compose.yaml  Makefile (up, migrate, creds, test, eval, eval-report, replay, cdk-*)  .env.example
```

## Data model (Drizzle-owned; Python reads and writes via SQL; a schema-contract test in CI guards drift)
- **Weekend 1:** `users`, `documents`, `ingestion_jobs`, `chunks` (halfvec + generated `tsv` + HNSW + GIN), `conversations`, `messages` (idempotent `client_message_id`, `citations` jsonb, status), `feedback`, `rag_requests`, `retrievals`, `llm_calls`, `model_prices` (versioned, EXCLUDE constraint), `user_daily_usage`, `app_daily_usage`.
- **Weekend 2:** `response_cache`, `cost_savings` (mechanism, `estimated` or `replay`), `budget_reservations`, `admin_audit` (cut-if-behind).
- **DB roles:** `smartdoc_owner` runs DDL and migrations; `smartdoc_app` has DML only. RLS and per-service roles are stretch.

## Cost mechanisms (each measured and shown)
1. **Reasoning and output controls**: effort none, low verbosity, output cap.
2. **Retrieval gate**: no LLM call when nothing relevant is found.
3. **Cache-aware prompt layout**: explicit breakpoint. Net savings are computed from `cached_tokens` and `cache_write_tokens`.
4. **Context budget**: k=5, ≤ 2,000 tokens.
5. **History budget**: last 3 turns, ≤ 800 tokens.
6. **Exact response cache**: tenant-scoped, $0 per hit.
7. **File-level dedup**: SHA-256 → 409.
8. **Budgets**: per-user $0.25/day, global $2/day, OpenAI project hard limits, throttler by `sub`.
9. **Abort propagation and degraded mode.**

**How savings are proven:**
- A replay of 300 questions per arm (naive / sensible / optimized, with a stated 20% repeat ratio) produces a README waterfall.
- Savings are always shown as absolute $ next to %, plus the TCO crossover: LLM spend overtakes AWS at about 53k queries/month.

## Quality and evaluation
- **Online signals:** thumbs + reasons, `max_cos`, `fts_nonempty`, no-answer and degraded rates, latency percentiles, citation coverage. Langfuse traces are deep-linked from the thumbs-down table.
- **Datasets:** `golden_v1` (40, human-verified synthetic plus hand-written unanswerable and cross-tenant items), `retrieval_synth_v1` (~150), `canaries_v1` (12 prompt-injection cases in 4 classes).
- **Metric tiers:**
  1. CI, deterministic: Recall@k, MRR, gate refusal accuracy, 0 cross-tenant leaks.
  2. Local, live LLM (about $0.02 per config): citation precision, refusal accuracy, false-refusal rate, injection success, $/query.
  3. Report-only judge: RAGAS Faithfulness + ResponseRelevancy, with a 20-label human calibration.
- **Sweeps:** τ × lexemes, k ∈ {3,5,8}, hybrid on/off, effort low, short prompt. Claims are pre-registered in `claims.yaml`. `make eval-report` rewrites the README table between markers; nothing is typed by hand.

## Security highlights
- **Tokens:** access tokens only (`tokenUse`, `clientId`).
- **Tenant scoping:** `TenantContext` from `sub`. Unowned resources return 404. A **generated IDOR test** covers every `:id` route. Python re-verifies the document scope (`FOR SHARE`) and every SQL query filters by `tenant_id`.
- **Prompt injection:** all untrusted text is HTML-escaped inside `<document>` tags, bidi and zero-width characters are stripped, and the prompt has an "untrusted data" rule. Output links are allowlisted; no remote images.
- **Parser DoS:** the parse child runs under rlimits and a timeout; a zip-bomb fixture is tested.
- **Document delete:** cascades to chunks and cache, redacts snippets in old citations, and deletes all S3 versions.
- **Logs:** pino redaction; the CI log grep for `"Bearer ey"` must return 0.
- **Edge and host:** WAF, a security group limited to the CloudFront prefix list, an origin secret header, SSM Session Manager (no SSH), IMDSv2.

## AWS infra and cost
- **CDK stacks:** `Ci` (GitHub OIDC role), `{Dev,Prod}-Storage` (docs, backups, artifacts, ECR; plus the dev-only `SmartDocDevApp` role), `{Dev,Prod}-Auth` (user pool, PKCE client, admin group), `Prod-Compute` (VPC without NAT, EC2, 10 GiB data volume, EIP, SSM deploy document, alarms, $25 budget), `Prod-Edge` in us-east-1 (ACM, WAF, CloudFront, CF Functions, Route 53, health check).
- **Instance:** t4g.small with memory limits (db 512m, worker 448m, api/ai 256m each), 2 GiB swap, and a RAM acceptance test. Resize trigger: memory above 85% → t4g.medium.
- **Backups:** nightly and pre-deploy `pg_dump` to S3; one restore drill with the RTO recorded.
- **Monthly cost:** about **$10** during the T4g trial (EBS $2.9, IPv4 $3.7, OpenAI demo traffic about $2.5). About **$24** at list price. The build itself costs about $5–10 of OpenAI in total.

## Documentation deliverables
- **PRD.md**, including a "What enterprise would add" section and a privacy/data-flows section.
- **ARCHITECTURE.md**: C4 and sequence diagrams, ERD, capacity table, failure modes.
- **10 ADRs**, each citing a measured number.
- **INTERVIEW.md**: pitch, why-not-X answers, cost/quality/security stories.
- **BUILD_LOG.md**: planned vs actual hours.
- **README**: generated results tables, τ chart, savings waterfall.

## Schedule (≈ 42 focused hours; the cut list is expected to be used)
**Block 0, Friday 1 evening (3 h)**
- Accounts:
  - SSO profile, `cdk bootstrap` in both regions, flat-rate eligibility check.
  - OpenAI projects with enforced limits (dev $10, eval $15, prod $20).
  - Langfuse EU, GitHub repo, 3–5 licensed corpus PDFs.
- **OpenAI spike**: Luna streaming + explicit breakpoint. Confirm `cache_write_tokens` and `cached_tokens`, whether `temperature` is accepted, and the Flex result.
- Toolchain: NestJS 12 ESM timebox vs 11.2.x, uv on Python 3.13, Yarn 4.

**Weekend 1 + Friday 2: local MVP (21 h)**
| Block | h | Done when |
|---|---|---|
| 1.1 Compose + Dockerfiles + health endpoints + `make creds` | 2 | all containers healthy |
| 1.2 CDK dev Storage + Auth; invite self | 1.5 | sign-in works, presign works |
| 1.3 Drizzle schema (13 tables) + custom SQL + roles + migrate | 2 | `\d chunks` shows halfvec, HNSW and GIN; the ledger trigger works |
| 1.4 Auth end to end (login/callback/logout + revoke; guard; throttler) | 2 | bad, ID-token and wrong-client tokens → 401 |
| 1.5 Presigned POST + `/complete` + documents UI | 1.5 | 21 MB rejected, fake PDF → 422 |
| 1.6 Ingestion worker (queue, sandbox, chunk, embed, ledger) | 4 | a 100-page PDF reaches `ready`; scanned PDF → `NO_TEXT_LAYER`; zip bomb survived |
| 1.7 Python chat (scope check, hybrid SQL, gate, prompt, stream, citations, breaker) | 3.5 | `curl -N` shows `meta → sources → token → done`; second call has `cached ≥ 1024`; degraded mode works |
| 1.8 NestJS SSE proxy (idempotency, persistence, abort, housekeeping) | 1.5 | same `clientMessageId` twice → 1 LLM call |
| 1.9 Chat UI (stream, citation chips, open PDF at page N, cost badge, thumbs) | 3 | full loop in the browser. **MVP gate:** if not done, drop the Cost page and judge now |

**Weekend 2: production, eval, AWS (18 h)**
| Block | h | Done when |
|---|---|---|
| 2.1 Tenancy e2e + generated IDOR test + core pytest | 1 | user B gets 404 everywhere |
| 2.2 Deploy spike: CDK prod stacks, Caddy, CloudFront, 90-s SSE test | 4 | SSE not cut through CloudFront; origin without the header → 403 |
| 2.3 `ci.yml` + `deploy.yml` + secrets + RAM test + rollback | 3 | merge → live in < 15 min |
| 2.4 Budgets (reservations, release, sweeper, 429 UI) | 1 | parallel requests overshoot by ≤ 1 reservation |
| 2.5 Exact cache + savings rows + history budget + file dedup | 2 | cached at $0; a new upload makes the next ask miss |
| 2.6 Eval datasets + `run_eval.py` + CI fixture + `claims.yaml` | 2.5 | CI eval runs with zero API calls |
| 2.7 Sweeps + RAGAS spike + judge + `report.py` | 1.5 | README table + τ chart generated |
| 2.8 Prod replay (3 arms) + Cost page | 2 | waterfall rendered; tokens reconcile within ±2% |
| 2.9 INTERVIEW.md, README, PRD, restore drill | 1 | RTO recorded |

**Cut if behind (in order):**
- a. Chunk-hash embedding reuse.
- b. Injection heuristic scorer.
- c. Standalone question rewrite.
- d. RAGAS judge.
- e. Leave-one-out replays.
- f. Langfuse.
- g. The `messy_v1` dataset.
- h. `admin_audit` and refresh-token rotation.
- i. Flex for the judge.

**Never cut:** demo live, auth + tenant isolation + IDOR test, ledger + budgets, the cost badge, scope check + prompt escaping, degraded mode, one measured naive-vs-optimized $/1k number, one tested restore.

**Stretch:** RLS + role split, semantic cache with a false-hit eval, gpt-6-sol "deep answer" routing, FlashRank, promptfoo red-teaming, Playwright, workspaces, a Bedrock comparison through the same harness.

## Verification (end-to-end highlights; the full 40-row matrix is in docs/IMPLEMENTATION_PLAN.md)
- `docker compose down -v && make up` → migrate exits 0, schema-contract and privilege tests pass.
- Auth matrix via curl: no token / access / ID / dev-pool / wrong-client → 401 / 200 / 401 / 401 / 401.
- Generated IDOR e2e: all 404. The 100 cross-tenant probes in eval return 0 leaks.
- Uploads: 21 MB → S3 rejects; fake PDF → 422. Killing the worker mid-ingest → the retry succeeds and the ledger rows are intact.
- Chat:
  - SSE event order is correct.
  - A repeat question hits the exact cache at $0; after a new upload it misses.
  - A gate question produces no chat LLM call.
  - `OPENAI_BASE_URL` pointed at a black hole → degraded answer.
  - Ctrl-C → `aborted` + ledger row.
- Budget integration tests: first request of the day, 10 parallel requests, midnight rollover.
- `make eval && make eval-report` → thresholds pass, README regenerated. A PR that breaks RRF fails CI.
- Prod:
  - A 90-s SSE stream through CloudFront is not cut; the origin is 403 without the header; IMDS times out from the `ai` container.
  - The log grep finds 0 tokens; a forced alarm sends email.
  - Restore drill counts match; redeploying the previous SHA works.

## Risks and items to verify at build time
- **Risks:**
  - The 42 h estimate is tight, and the Python-heavy work is in the weaker language. Realistically expect the cut list to be used; BUILD_LOG turns the overrun into a story.
  - gpt-6-luna is days old and an undated alias. Mitigations: model ID in config, `response.model` stamped on results, a smoke eval before demos.
  - RAGAS may break with GPT-6. Mitigations: the 30-minute spike, `gpt-4o-mini` as judge, DeepEval as fallback.
  - t4g.small RAM (limits and `oom_score_adj` so the worker dies first). Let's Encrypt rate limits (staging CA first). Slovak PDFs (FTS is `english`; documented).
- **Unverified; check during Block 0 and the 2.2 spike:**
  - Explicit-breakpoint SDK field shapes, whether `temperature` is accepted, Flex for Luna.
  - Checksum fields in the presigned POST.
  - WAF overrides on the Free plan; the X-Forwarded-For chain through CloudFront → Caddy → Express.

## Execution after approval
1. `git init`. Scaffold the monorepo skeleton and `docs/` stubs (PRD, ARCHITECTURE, BUILD_LOG).
2. Update memory: the Python AI service decision replaces "Python only for eval". Record the key stack decisions.
3. **Block 0 needs the user's hands.** Claude prepares scripts and runbooks:
   - AWS SSO login and `cdk bootstrap`.
   - Creating OpenAI projects and keys, setting limits and prepaying.
   - The Langfuse account.
   - Entering secret values into SSM.
   - Subscribing to the CloudFront flat-rate plan in the console.
4. Then build block by block per the schedule, logging hours in BUILD_LOG.md. Commit per block; open a PR per weekend; squash-merge.
