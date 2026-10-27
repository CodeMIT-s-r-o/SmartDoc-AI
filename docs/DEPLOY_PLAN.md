# Deployment plan: smartdoc.codemit.sk

How the working local stack becomes a public demo, in the same serverless shape as **randevu** and
**grosik**: Lambda behind CloudFront, Aurora Serverless v2 that pauses when idle, Secrets Manager,
and `cdk deploy` from GitHub Actions through OIDC after every green CI run on `main`.

This replaces the single-EC2 layout of [IMPLEMENTATION_PLAN.md §10](IMPLEMENTATION_PLAN.md#10-aws-infrastructure),
which stays below as the fallback. It covers Blocks 2.2 (deploy spike) and 2.3 (CI/CD and the
real app).

## Why the change

| | EC2 (§10) | Lambda + Aurora (randevu, grosik) |
|---|---|---|
| Monthly, demo traffic | ≈ $7.3 until 2026-12-31 (T4g trial), then ≈ $21.3 | ≈ $3–7 |
| Idle month | ≈ $7–21 (the instance runs anyway) | ≈ $2 (storage, secrets, images) |
| Operations | OS patches, Docker, Caddy, disk, `pg_dump` timer | none; Aurora backups are built in |
| Shared with the other projects | nothing | CI role, cert stack, zone import, image builds, `deploy.yml`, smoke test |
| Costs us | | streaming through Lambda, a Data API adapter in Python, SQS for ingestion, cold starts |

## Target in one picture

```text
browser ──► CloudFront (smartdoc.codemit.sk, ACM certificate in us-east-1)
             ├─ default ─► S3 SPA bucket (OAC; response headers policy with the CSP)
             └─ /api/*  ─► Lambda Function URL (AWS_IAM via OAC, RESPONSE_STREAM)
                            NestJS API (Lambda Web Adapter)
                             ├─ SigV4, streamed ─► Lambda Function URL: FastAPI chat (Python)
                             ├─ SQS ingest ──────► Lambda: ingest worker (same Python image)
                             └─ Data API ───────► Aurora Serverless v2, PostgreSQL 17 + pgvector,
                                                  min 0 ACU (pauses when idle), no NAT, no VPC Lambdas
EventBridge Scheduler (hourly, flexible window) ─► API housekeeping
Secrets Manager smartdoc/prod/app · Cognito prod pool · S3 documents · CloudWatch alarms · AWS Budget
```

## Status

| Piece | State |
|---|---|
| AWS account 163897793430, region eu-central-1 (with randevu and grosik) | exists |
| Route 53 zone `codemit.sk` (`Z098890928LZU3VCIGGZE`, owned by codemit-website), imported like randevu | exists |
| GitHub OIDC provider in the account | exists |
| CDK bootstrap in eu-central-1 and us-east-1 | exists (randevu and grosik deploy there) |
| Dev Storage + Auth stacks (Block 1.2) | deployed |
| CI (`.github/workflows/ci.yml`): lint, types, tests, DB tests, offline eval, gitleaks | done |
| Phase 1: streaming spike | **passed** 2026-10-27 (below) |
| App changes for Lambda (below) | to build |
| Stacks: `SmartDoc-Ci`, `SmartDoc-Prod-{Cert,Data,Async,App,Ops}` | to build |
| `deploy.yml` | to build |

## Prerequisites (only you can do these)

- [ ] **OpenAI project `smartdoc-prod`** with an *enforced* monthly hard limit ($20), its own key
      and a $10–20 prepaid balance.
- [ ] **GitHub Environment `prod`** in the SmartDoc-AI repository, restricted to `main`
      (Settings → Environments). Optional: a required reviewer for the first deploys.
- [ ] **Prod secrets** after the Data stack exists: `scripts/init-secrets.sh prod` asks for the
      OpenAI key and generates the internal token, as in randevu (names only in
      `docs/runbooks/prod-secrets.md`, never values).
- [ ] **Invite yourself** to the prod user pool: `make invite STAGE=prod EMAIL=… ADMIN=1`.

**Image builds:** the repository is **public**, so GitHub's native arm64 runners
(`ubuntu-24.04-arm`) are free. The images build natively instead of under QEMU (randevu and grosik
are private and use QEMU).

## What changes in the app

1. **Database access through the Data API.** The Lambdas stay outside the VPC, so they reach OpenAI
   and Cognito without a NAT.
   - NestJS: Drizzle's `aws-data-api/pg` driver in AWS and `node-postgres` locally and in tests, as
     in grosik and randevu. Raw `db.execute(sql…)` results are read through one helper that
     handles both result shapes.
   - Python: a small `Db` interface with two implementations, psycopg (local, tests, CI) and
     `rds-data` (AWS). Vectors go in as text with `::halfvec` casts. Transactions use
     `BeginTransaction`/`CommitTransaction`. The Data API limits (1 MB per result, 45 s per
     statement) are far above what retrieval returns.
   - The database tests run against both implementations' SQL (the psycopg one in CI), and the
     smoke test exercises the Data API one.
2. **Ingestion through SQS instead of the Postgres job queue.** "Upload complete" sends one message
   per document. The worker Lambda (the same Python image, a second handler) processes it, and SQS
   handles retries (`maxReceiveCount: 3`, then a DLQ with an alarm). Locally, ElasticMQ in compose
   stands in for SQS, as in randevu. Lambda limits: 2 GB memory, 10 minute timeout, 512 MB `/tmp`,
   with the sandboxed parser's resource limits kept.
3. **Streaming through Lambda.** grosik polls; SmartDoc streams SSE, so both functions use the
   Lambda Web Adapter with `AWS_LWA_INVOKE_MODE=response_stream` and Function URLs with
   `InvokeMode: RESPONSE_STREAM`. NestJS calls the AI function's URL with a SigV4-signed `fetch`
   and passes the stream through as it does today. **This is the riskiest piece, so it is spiked
   first (Phase 1).**
4. **No timers in the process.** The housekeeping tick (expired budget reservations, stuck
   `streaming` messages) becomes a handler that EventBridge Scheduler invokes **hourly**, and
   `reserve()` also releases expired reservations itself. Nothing on a timer may touch the
   database more often than the auto-pause delay, or Aurora never pauses (≈ $50 a month at its
   0.5 ACU idle floor).
5. **Cold starts.** NestJS takes 1–3 s, the Python image 2–4 s, and Aurora ≈ 15 s to resume from a
   pause.
   - `/api/health` answers `503 db.resuming` while the database wakes up, as in grosik.
   - The web app shows "Waking up…" and retries.
   - The auto-pause delay is 1 hour. Before an interview, open the app a minute early.
6. **Secrets.** Secrets Manager `smartdoc/prod/app` (OpenAI key, internal token) is read at cold
   start through `SECRETS_ID`, and CDK generates the database secret. Two secrets cost ≈ $0.80 a
   month.
7. **CloudFront in front of Function URLs.** With OAC, the browser must send
   `x-amz-content-sha256` on every POST, as randevu does (`sha256Hex` already exists in the web
   app). The CSP moves to a CloudFront response headers policy.
8. **Migrations** run in a CDK `TriggerFunction` after every deploy whose image changed. A failure
   fails the deploy, as in randevu.

## CI/CD, as in randevu and grosik

- **`ci.yml`** stays as it is: lint, types, unit tests, DB tests, offline eval, gitleaks.
- **`SmartDoc-Ci` stack**, deployed once by hand: the role `smartdoc-github-deploy`.
  - Only jobs of this repository in the Environment `prod` can assume it, matched on the
    repository's numeric IDs.
  - It can only assume the CDK bootstrap roles and sign in to the public ECR.
- **`deploy.yml`:**
  - **Trigger:** `workflow_run` after CI succeeds on a push to `main`, or by hand
    (`workflow_dispatch`).
  - **Job:** environment `prod`, `concurrency: deploy-prod`, running on `ubuntu-24.04-arm`.
  - **Steps:**
    1. checkout of the CI run's SHA;
    2. Node 24 and Yarn;
    3. `yarn workspace @smartdoc/web build` (Cognito and API settings from the stack outputs);
    4. buildx;
    5. `configure-aws-credentials` with the role;
    6. sign in to the public ECR;
    7. `npx cdk deploy 'SmartDoc-Prod-*' --require-approval never --concurrency 3`.
  - **Smoke test:**
    - `GET /` contains `<div id="root">`;
    - `/api/health` returns `version == run_number` and `db == ok`, with retries while Aurora
      resumes;
    - one SSE answer end to end, against a smoke tenant with a $0.01 budget.
- **Merge to `main` → live in ≈ 10 minutes.** Rollback is "Run workflow" on the previous green
  commit.

## Order of work

Each phase ends in a check that must pass before the next one starts.

### Phase 1: Streaming spike (≈ 2 h): passed

A throwaway `SmartDoc-Spike` stack with the same pieces and no app:
- CloudFront → OAC → a Node Function URL (LWA, streaming), which calls a Python Function URL
  (LWA, streaming, SigV4) that emits an SSE event every second for 90 s.

**Check:**
- the 90 s stream is not cut, and events arrive as they are sent, not buffered;
- a request without OAC signing gets 403;
- the cold-start time of each function is recorded.

**If streaming fails:** the fallback is the EC2 layout below for the API and AI, with Aurora kept.
It is not polling, because the chat UI depends on SSE.

**Result (2026-10-27, [infra/spike/](../infra/spike/)):** three concurrent 90 s streams through
CloudFront: Node alone, Node relaying Python, and the same as a POST with a payload hash.

| Check | Result |
|---|---|
| Events received / sent | 90 / 90 on every stream, `done` arrived |
| Largest gap between two events | 1.0 s (no buffering anywhere on the path) |
| Time to first byte, warm | 130–320 ms |
| Time to first byte, both functions cold | 6.6 s (Node init 0.8–1.0 s, Python init 4.7 s) |
| Function URL called without CloudFront | 403 |
| POST through CloudFront without `x-amz-content-sha256` | 403 (the browser must send it) |

- **New Function URLs need two permissions:** `lambda:InvokeFunctionUrl` and also
  `lambda:InvokeFunction` with the condition `lambda:InvokedViaFunctionUrl`. Without the second
  one, every call returned 403. CDK's `grantInvokeUrl` and the CloudFront OAC origin add only the
  first, so the stacks add the second explicitly:
  - for CloudFront → API: `addPermission` with `invokedViaFunctionUrl: true`;
  - for API → AI: a role policy statement.

  randevu and grosik do not need this because their URLs are older.
- **The Python cold start dominates.** The real AI image imports more (openai, pypdf, psycopg), so
  expect 5–8 s.
  - Lazy imports cut it down: the parser is needed only by the ingest handler.
  - A cold demo request can wait ≈ 25 s in total, Aurora's resume included. The "Waking up…"
    state covers that.
- **Log groups outlive `cdk destroy`.** The stacks set a retention, and outside prod a removal
  policy of `DESTROY`.

### Phase 2: App changes (≈ 1 day)

Items 1–8 above, each behind a driver switch (`DB_DRIVER`, `QUEUE_DRIVER`), so `make up`, the tests
and CI keep working unchanged.

**Check:** `make check`, `make test-db` and `make eval-ci` are green, and the local stack runs with
ElasticMQ.

### Phase 3: Stacks and the first deploy (≈ 4 h)

Copy and adapt from randevu and grosik: `config.ts`, `zone.ts`, `ci-stack.ts`, `cert-stack.ts`,
`images.ts`, `site.ts` (CSP), plus snapshot tests next to the existing ones.

| Stack | Contents |
|---|---|
| **Cert** (us-east-1) | certificate for `smartdoc.codemit.sk` |
| **Data** | Aurora (PG 17, pgvector, min 0 / max 2 ACU, Data API, 7-day backups, deletion protection), documents bucket (CORS for the domain only) |
| **Async** | SQS ingest queue, DLQ, scheduler role |
| **App** | three functions, Function URLs, CloudFront (SPA + `/api/*`), migrations trigger, hourly schedule |
| **Ops** | alarms on errors, DLQ depth and throttles; AWS Budget $10 with alerts to `OWNER_EMAIL` |

The prod Cognito pool already has the domain's callbacks parameterized (`config.ts`).

**Check:**
- `cdk diff` is clean after the deploy;
- the smoke test passes;
- a 20 MB PDF ingests;
- `Bearer ey` appears 0 times in CloudWatch Logs.

### Phase 4: Operations (≈ 1 h)

- Backups are Aurora's own (7 days, point-in-time). **Restore drill:** restore into a new cluster,
  compare row counts and record the RTO (Block 2.9).
- `cdk gc` once a month: the CDK asset repository in ECR keeps every old image.
- Re-run the cost replay against prod and reconcile tokens with the OpenAI usage export (±2 %).

## Cost (estimate, demo traffic ≈ 6k answers a month)

| Item | Monthly |
|---|---|
| Lambda, SQS, Scheduler, CloudFront | ≈ $0 (always-free tiers: 1M requests and 400k GB-s of Lambda, 1 TB of CloudFront) |
| Aurora Serverless v2: billed only while awake, plus storage (≈ 1 GB) | ≈ $1–4 |
| Secrets Manager (2), CloudWatch logs and alarms, ECR images | ≈ $1.5–2.5 |
| Route 53 | ≈ $0 (the zone is shared with codemit.sk) |
| **AWS total** | **≈ $3–7** (grosik estimates $5–10 for the same shape) |
| OpenAI | ≈ $1.2 (replay: $0.20 per 1k queries) |

## Risks

| Risk | Mitigation |
|---|---|
| SSE buffered or cut between CloudFront and Lambda | Phase 1 proves it before any app change; fallback is EC2 for the compute |
| Aurora never pauses (a timer or a monitor keeps it awake) | Hourly housekeeping only; the health check reads the DB only when asked; the Budget alarm catches it within a day |
| Cold start + resume ≈ 20 s on the first request | "Waking up…" state in the UI; open the app before a demo |
| Data API adapter in Python differs from psycopg | The same SQL in both; DB tests in CI on psycopg, the smoke test on the Data API |
| Cost run-away | Per-user and global daily budgets (done), OpenAI hard limit, AWS Budget |

## Fallback: single EC2 instance

If Phase 1 fails, the compute goes to the layout of IMPLEMENTATION_PLAN §10:
- t4g.small with Caddy and the compose stack;
- CloudFront with an origin-verify header;
- deployed through an SSM `send-command`.

It costs ≈ $7.3 a month until 2026-12-31 and ≈ $21.3 after.
