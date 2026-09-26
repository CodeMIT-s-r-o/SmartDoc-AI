# Review: feasibility-cost

## Verdict

FEASIBILITY: the architecture is sound and cheap to run, but the schedule is about 1.6x over-committed. I re-estimated each block assuming a TypeScript-strong developer using an AI pair and about 8-9 focused hours a day. Weekend 1 comes to about 27.5 h (the plan budgets 20), Weekend 2 to about 36.5 h (plan: 20), and Block 0 to about 3 h. That is roughly 67 h against the plan's 42.5 h, and 2 weekends plus 2 Friday evenings realistically give 38-42 h. So about 35% of the scope has to be cut now, not "if behind". Most cuts belong in Weekend 2's breadth (sweeps, dashboard, docs, observability plumbing), not in the MVP.

COST: the AWS numbers hold up.
- About $7.6/month until the T4g trial ends on 2026-12-31, about $21.6/month at list price after that.
- OpenAI spend for development plus eval over both weekends is about $5-10 in total.
- The real footprint risks are RAM on 2 GiB (fixable) and the flat-rate plan's hard limits: a WAF ACL is mandatory and capped at 5 rules, and an account still on the AWS Free Tier is not eligible.

Checked today:
- psycopg-binary 3.3.6 and tiktoken 0.14.0 do ship cp314 aarch64 wheels. The real Python 3.14 blocker is ragas -> scikit-network, which has no cp314 wheels.
- pgvector/pgvector:0.8.6-pg18, python:3.14-slim and node:24-slim all have arm64 images.
- The NestJS 12 ecosystem is compatible (swagger 12.0.2, config 12.0.1, throttler 6.7.1, nestjs-pino 5.2.1). But the Nest 12 packages are ESM-only, and 12.0.0 shipped on 2026-08-27. 11.2.6 (dist-tag `legacy`) was still being patched on 2026-09-23.
- aws-cdk-lib is now 2.271.0.

TIGHTENED SCHEDULE (about 42 h; the scope is cut, not the hours; ADR stubs are written during the blocks, 15 min each):
- **Fri-1, Block 0 (3 h):**
  - SSO, `cdk bootstrap` in both regions, flat-rate eligibility (and the number of records in the hosted zone, max 50 on Free), OpenAI projects, Langfuse EU (1 h).
  - **OpenAI spike script** (1 h): gpt-6-luna with Responses streaming, effort none, explicit breakpoint. Read cached_tokens and cache_write_tokens on the 2nd call, and make one embeddings call.
  - Toolchain decisions (1 h): Python 3.13; a 20-minute `nest new` timebox on 12, falling back to 11.2.x if ESM gets in the way; Yarn 4 workspaces; `uv init`.
- **Sat-1 (9 h):**
  - compose (db/api/ai/worker), dev Dockerfiles, health endpoints, `make creds` (2 h)
  - CDK dev Storage + Auth, no branding and no cdk-nag, invite yourself (1.5 h)
  - Drizzle schema, Weekend 1 subset of 12 tables: vector extension, ledger trigger, price seed, 2 roles (2 h)
  - Auth end to end, including the Cognito logout workaround and user upsert (2 h)
  - Presigned POST, /complete, documents list UI (1.5 h)
- **Sun-1 (9 h):**
  - Worker (4 h): polling queue with SKIP LOCKED and a lease, pypdf + cleaning, a 45-min timebox on outline sections, page-range chunking, batch embedding, one-transaction write, failure codes.
  - Python chat pipeline (3.5 h): hybrid SQL, gate, prompt v1 with breakpoint, stream, sentinel, citations, ledger, rag_requests.
  - NestJS SSE pipe (1.5 h): one loop, no tee; persist on done/abort; curl checks.
- **Fri-2 (3 h):** chat UI: streaming, react-markdown without HTML, citation chips + "open PDF p.N", cost badge, thumbs. If the MVP is not finished by now, Weekend 2 shrinks further.
- **Sat-2 (9 h):**
  - Two-user tenancy e2e + core pytest (1 h)
  - **Deploy spike** (4 h): CDK Compute + Edge, Caddy with the Let's Encrypt staging CA, a 90-s SSE test through CloudFront, UNLIMITED credits during the weekend
  - CI (lint/test/migrate/schema contract) + deploy.yml (OIDC -> ECR -> SSM) + web deploy + secrets; the real app goes live (3 h)
  - Budget reservation + 429 banner + throttler (1 h)
- **Sun-2 (9 h):**
  - Exact cache + scope_hash + cost_savings + history budget (2 h)
  - 40-item golden set from LLM-assisted candidates plus human review; run_eval tier 1; zero-LLM CI fixture (2.5 h)
  - τ/k/hybrid swept offline from stored scores; RAGAS Faithfulness + ResponseRelevancy on the baseline and 1-2 variants; report.py -> README table + τ chart (1.5 h)
  - Naive-vs-optimized replay run inside the compose network on prod (1 h), and a minimal Cost page (1 h)
  - INTERVIEW.md, README results, PRD skeleton, restore drill (1 h)
- Buffer: none, so the "cut if behind" list below will probably be used.
- If weekday evenings are available, spend them on Langfuse (Python-only) and the docs, not on features.

PRIORITIZED CUT LIST, CUT NOW (about 22-26 h saved; top first):
1. Semantic cache: code, `cache_pairs` and eval. Describe the method as future work.
2. Model trio, chunk-size sweep and the 3x repeats of the final configs.
3. RAGAS TestsetGenerator. Also avoids its dependency weight.
4. RLS and the 3 per-service roles. Keep 2 roles (owner/app) plus the app filters, the tenancy tests and the 100-probe script.
5. LISTEN/NOTIFY and per-stage lease heartbeats. Poll every 2 s with SKIP LOCKED plus a lease.
6. NestJS OTel and traceparent. Langfuse from Python only, joined by request_id.
7. The full Ops dashboard. Build one page with 4 tiles, cost/day by purpose, a savings waterfall and a thumbs-down table. "My usage" becomes a header chip.
8. 24 ADRs. Write 10 and keep the rest as the one-line register.
9. OpenAPI drift check, cdk-nag, managed-login branding, CI eval with LLM calls, docker buildx in ci.yml.
10. DLM. Keep the nightly pg_dump and the restore drill.

CUT IF BEHIND (in order):
- a. Chunk-hash embedding reuse (keep the file-level 409).
- b. Injection regex scorer (keep the 5 canary docs plus the prompt rule).
- c. Standalone rewrite (measure and document the follow-up limitation).
- d. RAGAS judge metrics.
- e. Per-lever replays (keep naive vs optimized only).
- f. Langfuse entirely.
- g. The budget concurrency test.

NEVER CUT: everything already on the plan's never-cut list, plus the per-answer cost badge and one measured naive-vs-optimized $/1k number.

## Issues

### Critical (1)

**1. Schedule / hour estimates**

- **Problem:** Block estimates are 1.3-3x optimistic.

Plan -> realistic hours, Weekend 1:
- 1.1: 1.5 -> 2.5
- 1.2: 1.5 -> 2
- 1.3 (about 16 tables, trigger, 3 roles + grants): 2 -> 3
- 1.4: 1.5 -> 2
- 1.5 (queue + NOTIFY + lease + pypdf cleaning + outline sections + page mapping + embedding + one-transaction write + UI): 3.5 -> 5.5
- 1.6 (Python pipeline + NestJS tee/abort/persist): 4 -> 6.5
- 1.7: 3 -> 4
- 1.8: 1.5 -> 2

Weekend 2:
- 2.1: 3 -> 4.5
- 2.2: 1 -> 2
- 2.3: 2.5 -> 4
- 2.4: 1.5 -> 2
- 2.5 (golden-set review alone takes about 2-3 min × 60 items plus 25 written by hand): 3 -> 6
- 2.6: 2 -> 3.5
- 2.7: 2 -> 3.5
- 2.8: 2.5 -> 4.5
- 2.9: 1 -> 2
- 2.10 (24 ADRs + PRD + ARCHITECTURE + INTERVIEW + restore drill): 1.5 -> 4.5

Total is about 67 h against a 42.5 h budget. The plan also assumes 10 focused hours a day, 4 days in a row.

Most of the Python-heavy work (worker, RAG, eval) sits in the author's weaker language, and several dependencies are days old: gpt-6-luna, openai 3.19.2 (published 2026-09-24), NestJS 12, and RAGAS with a GPT-6 issue opened 2026-09-24.
- **Fix:** Adopt the tightened schedule and the cut-now list from the verdict: same hours, about 35% less scope.
- Plan for 8-9 focused hours a day.
- Write each ADR as a 15-minute stub at the moment the decision is made, not at the end.
- Treat the cut-if-behind list as expected, not exceptional.
- Gate Weekend 2: if the MVP chat loop is not done by Fri-2, drop the dashboard and the judge metrics immediately.

### Major (9)

**1. Python version / ARM64 wheels**

- **Problem:** The fallback trigger for Python 3.14 is aimed at the wrong package.

These do ship cp314 wheels for manylinux aarch64 (checked on PyPI today):
- psycopg-binary 3.3.6
- tiktoken 0.14.0
- pydantic-core, jiter, orjson, uvloop, httptools, numpy, pyarrow
- onnxruntime 1.30

The real blocker: ragas 0.4.3 (released 2026-01-13) hard-depends on scikit-network. Its latest release, 0.33.5, ships wheels for cp310-cp313 only and has no cp314 wheel on any platform. So `uv sync` in eval/ builds it from sdist (Cython/C++ toolchain) on the Mac and in CI, or fails.

eval/ has an editable path dependency on services/ai, so both projects must resolve under one Python version.

Sources: https://pypi.org/pypi/ragas/json, https://pypi.org/pypi/scikit-network/json, https://pypi.org/pypi/psycopg-binary/json
- **Fix:** Decide in Block 0: Python 3.13 everywhere.
- Use `python:3.13-slim`.
- Set `requires-python = ">=3.13,<3.14"` in services/ai and in eval.
- 3.14 brings nothing this project needs.
- Keep ragas and langchain-* only in the eval project, never in the ai image.
- The openai version constraints are compatible: langchain-openai 1.6.6 needs openai >=2.45,<4 and instructor needs <4, so 3.19.2 resolves.

**2. NestJS 12 (ESM-only)**

- **Problem:** `@nestjs/core` and `@nestjs/common` 12.1.0 ship `"type":"module"` with ESM-only exports, and `@nestjs/cli` 12 is ESM too. NestJS 12.0.0 was released 2026-08-27; the plan's 09-23 date is the 12.1.0 minor.

Peer-dependency compatibility is fine: swagger 12.0.2, config 12.0.1, throttler 6.7.1 (peer ^12), nestjs-pino 5.2.1.

The friction is ESM itself:
- Jest ESM setup
- `.js` suffixes in relative imports
- drizzle-kit config and the migrate script
- decorator metadata under nodenext
- much less example and assistant coverage than for 11.x CJS

Source: https://registry.npmjs.org/@nestjs/core/12.1.0
- **Fix:** Timebox 20 minutes in Block 0: run `nest new`, add one e2e test and one Drizzle query.
- If anything fights you, pin 11.2.x. It is the npm dist-tag `legacy`, 11.2.6 was published 2026-09-23, and it is CJS.
- If you stay on 12, use Vitest in api as well (the same runner as web) rather than Jest.
- Either way, note the choice in the ADR.

**3. Deploy spike (2.1) + T4g CPU credits**

- **Problem:** Three hours for 5 CDK stacks across 2 regions plus EC2 user data, Caddy/Let's Encrypt, CloudFront, WAF and the flat-rate plan is optimistic.

Time sinks:
- Each CloudFront update takes about 3-10 min.
- ACM DNS validation.
- Debugging user data through SSM.
- Let's Encrypt's duplicate-certificate limit (5 per week for the same names) is easy to hit if the instance gets recreated.
- The unverified L1 for the flat-rate subscription.

On top of that, **T4g instances in STANDARD mode get no launch credits** (AWS doc: "T8i, T4g, T3a, and T3 instances do not receive launch credits"). First boot therefore runs at baseline: roughly 20% per vCPU for t4g.small, from memory, not re-verified. That covers dnf install docker, the compose download, image pulls and initdb, exactly while you are debugging.

Source: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-standard-mode-concepts.html
- **Fix:** - Launch with `CpuCredits.UNLIMITED` during Weekend 2 (surplus costs cents; the T4g trial says surplus credits are billed). Switch to STANDARD at the end; changing credit mode needs no replacement.
- Put Caddy's `/data` on the persistent EBS data volume, and use the Let's Encrypt staging CA until the flow works.
- Subscribe the flat-rate Free plan once in the console and document it in a runbook, rather than hunting for an L1.
- Budget 4-4.5 h. If a weekday evening is available, run the spike there.
- Keep the hello-world SSE-for-90-s test; it is the right first thing to prove.

**4. RAM budget on t4g.small (2 GiB)**

- **Problem:** The mem_limits add up to 1,632 MiB (512+288+384+384+64). About 1.9 GiB is usable, and the OS side needs roughly 350-450 MiB (estimate): kernel/systemd, dockerd + containerd + shims, SSM agent, CloudWatch agent. The limits are therefore overcommitted.

Under concurrent peaks the *global* OOM killer picks the largest RSS, which is Postgres. Likely peak triggers:
- ingesting a 20 MB, 500-page PDF with pypdf
- a deploy, which pulls images and runs a migration container and pg_dump
- a dnf-automatic run, since dnf itself can take 200-400 MB

Other hidden costs:
- Each Postgres connection costs about 5-10 MB, and default pools (pg pool 10, psycopg pools) inflate this.
- A Node heap of `--max-old-space-size=224` inside a 288 MiB limit leaves only about 64 MiB for everything outside the heap, so the container gets OOM-killed as the heap grows.
- Two tiktoken encodings (cl100k + o200k) roughly double the tokenizer memory in both Python containers.

Steady state should be about 1.0-1.2 GiB, so it fits, but only with these guards.
- **Fix:** - **Pools and connections:** api `pg` pool max 5, ai psycopg pool max 4, worker 1-2; Postgres `max_connections=30`.
- **Limits:** db 512m, api 256m with `--max-old-space-size=160`, ai 256m, ai-worker 448m, caddy 48m.
- **OOM priority:** `oom_score_adj` of -800 for db and +500 for the worker, so the worker dies first and its lease gets reclaimed.
- **Host:** `vm.swappiness=10`.
- **Postgres:** `shm_size: 128m`, or `max_parallel_maintenance_workers=0` on 2 vCPUs.
- **Tokenizer:** use one encoding and bake it into the image.
- **Ingestion:** cap it at 300 pages for the demo.
- **Updates:** run dnf security updates from a weekly 04:00 timer instead of dnf-automatic.
- **Acceptance test:** record `docker stats` while a 20 MB ingest, a chat and a deploy run together.

**5. Local dev friction (AWS credentials, native binaries)**

- **Problem:** 1. Only `ai` and `ai-worker` mount `~/.aws`. NestJS also needs AWS credentials: it presigns the POST, calls HeadObject, the range GetObject, ListObjectVersions and DeleteObjects, and runs AdminGetUser.
2. A `:ro` SSO cache can break token refresh inside the AWS SDKs.
3. On macOS arm64 vs linux arm64, Vite 8's rolldown/lightningcss bindings (per-platform optional dependencies) and Python wheels (psycopg_binary, pydantic_core) break if host `node_modules` or `.venv` get synced or bind-mounted into containers.
4. tiktoken downloads its BPE files from the internet on first use, in every fresh container and every CI run.
- **Fix:** - Add `make creds`, which runs `aws configure export-credentials --profile smartdoc-dev --format env-no-export > .env.aws`. Load it via `env_file` in api, ai and worker, and re-run it after `aws sso login`.
- Install dependencies inside the images, and add `node_modules` and `.venv` to .dockerignore and to the compose `develop.watch` ignore lists.
- Set `UV_PROJECT_ENVIRONMENT` outside the synced directory.
- Bake `TIKTOKEN_CACHE_DIR` into the image at build time.
- Allowed escape hatch: run Vite on the host with its proxy pointed at localhost:3000. Prod serves the SPA from S3 anyway, so this does not weaken the "everything in Docker" decision for the backend.

**6. Eval scope (2.5/2.6) and judge tier**

- **Problem:** - RAGAS TestsetGenerator runs a knowledge-graph pipeline: many LLM and embedding calls plus heavy dependencies. You still have to review every candidate against the PDFs.
- The 12-config sweep includes a model trio, which needs different parameter support and extra price rows, and chunk-size profiles, which need re-ingestion.
- Flex for the judge is unverified for gpt-6-luna. The Flex guide shows only other models and says it is in beta with limited model availability. It can return 429 resource-unavailable and needs timeouts of 15 min or more, which is wall-clock risk on a time-boxed Sunday for a saving of about $0.07 per run.

Source: https://developers.openai.com/api/docs/guides/flex-processing
- **Fix:** - **Golden set:** skip TestsetGenerator. A 40-line script asks the model for {question, answer, evidence_quote, page} on sampled chunks; you review about 30. Write about 10 by hand: unanswerable, cross-tenant, injection, follow-up. That gives about 40 items; at n≈40 the CI is about ±11 pp for p≈0.85, so say so.
- **Offline sweeps:** τ, k and hybrid on/off are retrieval-only. Compute them offline from stored top-1 scores and keyword hits, with zero LLM calls and in minutes.
- **LLM runs:** limit them to effort none vs low and the 3 cache modes (measure those in the replay).
- **Judge:** run it on the standard tier during the build. Use Flex only for final repeated runs, and only if Luna supports it.

**7. CI eval gate**

- **Problem:** Gating every PR on `citation_validity == 1.0` and `injection_success == 0` means gating on non-deterministic LLM output, so the check will flake. It also needs an OpenAI secret and a CI project, plus re-ingesting the corpus in every run.
- **Fix:** - **CI tier 1 (retrieval only):** Recall@k, MRR, refusal-by-gate and cross-tenant leaks. It needs zero OpenAI calls and is deterministic.
- **CI fixture:** commit a pg_dump of the embedded eval corpus plus a file of golden-question embeddings.
- **Generation metrics:** citation validity, sentinel refusal, injection and judge metrics run through `make eval` locally or the `run-eval` label. Commit the results JSON, which feeds the README.
- This removes the need for the CI OpenAI project.

**8. Replay and scripted tests need Cognito tokens**

- **Problem:** The only app client is PKCE. Scripts cannot get tokens non-interactively for:
- `replay.py` against prod with 2-3 test users
- the 10-parallel budget test
- the `curl -H Authorization: Bearer $T` checks

This is hidden work that no block accounts for.
- **Fix:** - **Replay:** run it inside the compose network (`docker compose exec ai python -m scripts.replay`) against `/internal/chat` with `X-Internal-Token` and seeded synthetic `users` rows. It writes the same `llm_calls` ledger, which is what the cost story measures.
- **API-level tests:** use tokens copied from the browser for a few manual curls, or add a dev-pool-only app client with `ALLOW_ADMIN_USER_PASSWORD_AUTH`, called through IAM. Never add it to prod.

**9. Weekend 1 over-engineering**

- **Problem:** Several Weekend 1 items add hours but little interview value before Weekend 2:
- LISTEN/NOTIFY on top of polling, since the psycopg notifies generator needs its own connection handling
- three login roles with per-table GRANTs, where `ALTER DEFAULT PRIVILEGES` gotchas cause permission-denied loops
- client-side SHA-256 plus CHECKSUM_MISMATCH
- `tee()` with two stream consumers in NestJS
- CfnManagedLoginBranding
- cdk-nag suppressions
- creating all ~17 tables upfront
- **Fix:** - **Queue:** 2-second poll with SKIP LOCKED plus lease plus attempts. NOTIFY is a latency optimization, and saying so is a good interview line.
- **Roles:** 2 in Weekend 1 (owner/app).
- **Schema:** only the 12 tables Weekend 1 needs; add the rest as additive Drizzle migrations.
- **Dedup:** file-level dedup (409) in Weekend 2.
- **SSE:** one read loop that writes each chunk to `res` and feeds eventsource-parser; persist on `done` or `close`. No tee.
- **Login:** default managed-login style.
- **cdk-nag:** Weekend 2 or stretch.
- **User email:** take it from the `/oauth2/userInfo` endpoint or the ID-token claim sent once; AdminGetUser and its IAM permission are not needed.

### Minor (5)

**1. Ops dashboard and docs breadth (2.8/2.10)**

- **Problem:** - The dashboard spec has about 10 KPI tiles, 6 charts, 3 tables and a My-usage page, all within 2.5 h that also includes the replay.
- The docs block covers 24 ADRs, PRD, ARCHITECTURE, INTERVIEW and a restore drill in 1.5 h. Documents you cannot defend line by line hurt more than missing ones.
- **Fix:** - **Cost page:** one page with 4 tiles ($/query p50, exact-cache hit %, prompt-cache token hit %, $ saved), cost/day by purpose, a savings waterfall and a thumbs-down table. Use Langfuse's built-in dashboards for latency.
- **My usage:** a header chip fed by /api/me.
- **ADRs:** 10 (service split, pgvector, thin AI stack, prompt caching, gate + exact cache, job queue, streaming, ledger + budgets, compute/edge, eval). The rest stay in the decision register.
- **INTERVIEW.md:** 1 h on its own.

**2. Tracing plumbing (2.2)**

- **Problem:** Tracing in both services needs a NodeSDK with LangfuseSpanProcessor plus traceparent propagation. It adds about 1 h, about 30-50 MB of RSS in api, and brings the known trace_context phantom-parent issue. NestJS makes no LLM calls.
- **Fix:** Use Langfuse from Python only. Root span `chat.request` goes in FastAPI, with request_id as a trace attribute; NestJS logs carry the same request_id. This is about 45 minutes of work, and the phantom-parent risk disappears.

**3. OpenAI dev/eval spend and hard limits**

- **Problem:** Estimated OpenAI spend across both weekends, from list prices on https://developers.openai.com/api/docs/pricing (Luna $0.10 input / $0.01 cached / $0.125 cache write / $0.50 output; embeddings $0.02):

| Item | Estimate |
|---|---|
| Development chats (~500-1,000) | ~$0.5 |
| Re-ingests | ~$0.1 |
| Golden-set candidates | < $0.1 |
| ~10 eval runs with a 2-metric judge on the standard tier | ~$1.5-2 |
| Naive + optimized + per-lever replays (naive runs at effort medium with k=8) | ~$1.5-2 |
| Mistakes (e.g. forgetting effort:none) | ~$1-3 |
| **Total** | **~$5-10** |

A $10 dev hard limit can trip in the middle of a sweep, and enforcement is not instantaneous (https://developers.openai.com/api/docs/guides/spend-limits). Hard limits must be explicitly enabled per project; otherwise they are alerts only.
- **Fix:** - Projects: `smartdoc-dev` $10 hard, a separate `smartdoc-eval` $15 hard (eval cost then shows up per project in the OpenAI dashboard, which is a good README line), `smartdoc-prod` $20 hard.
- Drop `smartdoc-ci` if CI makes no LLM calls.
- Tick "Enforce a hard limit" on each project.
- Remember that the API is prepaid credits: top up $10-20 in Block 0.

**4. Monthly AWS bill / flat-rate constraints**

- **Problem:** The line items check out:
- t4g.small list price $14.02; free through 2026-12-31 under the T4g trial (750 h aggregated across regions; surplus credits billed)
- IPv4 $3.65
- gp3 30 GB $2.86
- snapshots about $0.3

Flat-rate Free plan facts that matter (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html):
- A WAF web ACL association is **mandatory**.
- At most **5 WAF rules**, managed ones included. The plan uses 4, so there is no headroom.
- No header-based WAF rules and no custom response-header policies (the plan already moves CSP into a meta tag).
- 50 records per attached hosted zone.
- 1M requests and 100 GB per month.
- Accounts "using AWS Free Tier" are ineligible.
- The first 50 Route 53 health checks per account are free, which answers one of the plan's open questions.

On pay-as-you-go, WAF would be about $5 per ACL plus $1 per rule, roughly $9/month, so dropping WAF in the fallback is right.

After the trial the bill is about $22/month for as long as the demo is kept alive.
- **Fix:** - Keep the budget at $25 with anomaly detection.
- In Block 0, count the records in the codemit.sk zone and confirm the account is past its Free Tier.
- Don't add a 5th WAF rule casually.
- Add a "demo off-season" runbook. A stopped instance still costs about $6.5/month (EBS + EIP), so `cdk destroy` Compute and keep the SPA plus a recorded demo.

**5. Version facts in the plan**

- **Problem:** Updates as of today:
- aws-cdk-lib is 2.271.0 (the plan says 2.270.0).
- NestJS 12 GA was 2026-08-27, not about 09-23.
- The risk row "Python 3.14 aarch64 wheels (psycopg-binary)" is resolved; psycopg-binary 3.3.6 has cp314 aarch64 wheels.
- `ubuntu-24.04-arm` runners are free for public repos and $0.005/min beyond the included minutes for private repos (https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/).
- ARM consistency is a plus: Apple Silicon for development, arm64 GitHub runners and Graviton mean no QEMU anywhere.
- **Fix:** - Update the versions table and the risk rows.
- Make the repo public, which gives free arm64 CI and lets interviewers read the code.
- Mention the "same arch from laptop to prod" point in ADR-021.


## Likely interview questions (5)

**Q1. What does this cost to run, per month and per query?**

AWS is about $7.6/month while the T4g trial runs and about $22/month at list price: t4g.small $14, IPv4 $3.65, EBS about $3, and CloudFront + WAF on the flat-rate Free plan at $0. OpenAI for demo traffic is a few dollars. A query that reaches the model costs about $0.0004-0.0005 with gpt-6-luna. Cache hits and gated abstentions cost roughly only the query embedding. I measured the savings with an A/B replay from the ledger rather than estimating them.

**Q2. Why one EC2 instance with Docker Compose instead of ECS/Fargate or Lambda?**

Five long-running processes, including Postgres and a worker, fit in 2 GiB for about $14/month at list price. Fargate would cost several times that plus RDS, and Lambda fits poorly with long SSE streams and a queue worker. I accepted a single point of failure, backed by tested pg_dump restores. Resizing is one CDK line, and the scale path (RDS, ECS, SQS) is documented.

**Q3. How did you fit Postgres, NestJS and two Python processes into 2 GiB?**

Per-container memory limits sized from `docker stats` measurements, small connection pools with max_connections=30, and a capped Node heap. `oom_score_adj` makes the kernel kill the stateless worker before Postgres, and the worker's job lease makes that recoverable. Ingestion runs one job at a time with a page cap, and 2 GiB of swap is a safety net, not a working set. Memory alarms fire at 85% for an hour, which is my resize trigger.

**Q4. How did you keep LLM spend safe while developing and evaluating?**

There are three layers. First, a hard spend limit on each OpenAI project (dev, eval, prod), so eval cost shows up separately. Second, per-user and global daily budgets enforced by an atomic reservation in Postgres. Third, retrieval eval metrics in CI need zero LLM calls, because the embedded corpus and the query embeddings are committed fixtures; LLM-judge runs are manual and cost about $0.15 each. The whole build cost under about $10 in OpenAI spend.

**Q5. What did you cut to ship in two weekends, and why?**

I cut the semantic cache, RLS, the model and chunk-size sweeps, and full cross-service tracing. I kept everything that carries the product, cost and quality stories: tenancy tests, the cost ledger and budgets, the exact cache and retrieval gate, a deterministic eval with the README table generated from results, and HTTPS deploy through CI with a tested backup. Each cut is listed as future work, with the method I would use to measure it.
