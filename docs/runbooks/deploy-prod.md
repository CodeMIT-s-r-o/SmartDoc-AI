# Runbook: deploy to production (smartdoc.codemit.sk)

**Status (2026-10-27):** SmartDoc runs on localhost only, by decision. Nothing is deployed, and
nothing deploys by itself:
- **GitHub:** the only workflow is CI (`ci.yml`). It has no AWS credentials, no `id-token`
  permission and no secrets.
- **AWS:** only the two dev stacks that the local stack needs.

This runbook is the procedure for the day production is wanted: ≈ 1.5–2 days of work and
≈ $10–14 a month. The reasoning behind the design, with the options considered and the streaming
spike's evidence, is in [ADR-009](../adr/009-compute-and-edge.md).

## What exists today

| Where | What | Why |
|---|---|---|
| AWS `SmartDoc-Dev-Auth` | Cognito user pool, PKCE client, `admin` group | Sign-in on localhost |
| AWS `SmartDoc-Dev-Storage` | `smartdoc-dev-docs-…` bucket, the `SmartDocDevApp` role | Uploads and PDF links on localhost (`make creds`) |
| AWS SSM | `/smartdoc/dev/config/*` | Settings the local stack reads |
| GitHub | `ci.yml`, Environment `prod` restricted to `main` | CI; the environment does nothing until a deploy workflow exists |
| Shared with randevu and grosik | Route 53 zone `codemit.sk`, GitHub OIDC provider, CDK bootstrap in eu-central-1 and us-east-1 | Ready for Step 2, nothing to create |

The streaming spike (`SmartDoc-Spike`) is fully removed: its stack, log groups and images. Its code
stays in [infra/spike/](../../infra/spike/) as the recipe.

## Target

```text
browser ──► CloudFront (smartdoc.codemit.sk, ACM certificate in us-east-1)
             ├─ default ─► S3 SPA bucket (OAC; response headers policy with the CSP)
             └─ /api/*  ─► Lambda Function URL (AWS_IAM via OAC, RESPONSE_STREAM)

VPC, 2 AZs
├─ public subnet ─────── NAT instance (fck-nat, t4g.nano) ─► internet: OpenAI, Cognito, Secrets Manager, SQS
├─ private subnets ───── Lambda: api (NestJS, Lambda Web Adapter, streaming)
│   (egress via NAT)       ├─ SigV4, streamed ─► Lambda: ai (FastAPI, Lambda Web Adapter, streaming)
│                          └─ SQS ingest ──────► Lambda: ingest worker (same Python image)
├─ isolated subnets ──── Aurora Serverless v2, PostgreSQL 17 + pgvector, min 0 ACU (pauses when idle)
└─ S3 gateway endpoint (free): documents bucket without the NAT
EventBridge Scheduler (hourly) ─► api housekeeping · Secrets Manager smartdoc/prod/app · CloudWatch alarms · AWS Budget
```

The Lambdas run inside a VPC and talk to Aurora directly, so the app keeps psycopg and
node-postgres. randevu and grosik use the Data API instead, which would mean rewriting the DB layer
in two languages.

## Procedure

Each step ends with a check that must pass before the next one starts.

### Step 0: Prepare (you, 30 min)

- [x] An OpenAI project `smartdoc-prod` with an *enforced* monthly hard limit and its own key
      (2026-10-27).
- [x] GitHub Environment `prod`, restricted to `main` (2026-10-27).
- [ ] The monthly AWS budget for SmartDoc (suggested $20) and the e-mail for its alerts.

### Step 1: App changes (≈ 0.5–1 day, one PR)

Make the app runnable in Lambda; see [App changes](#app-changes) below. Each change sits behind a
switch, so `make up`, the tests and CI stay as they are.

**Check:** `make check`, `make test-db` and `make eval-ci` are green, and the local stack still
works end to end.

### Step 2: Stacks (≈ 4 h, one PR)

Copy and adapt from randevu and grosik: `config.ts`, `zone.ts`, `ci-stack.ts`, `cert-stack.ts`,
`images.ts`, `site.ts` (CSP). Add snapshot tests next to the existing ones in `infra/cdk/test/`.

| Stack | Contents |
|---|---|
| `SmartDoc-Ci` (deployed once, by hand) | The role `smartdoc-github-deploy`. Only jobs of this repository in the Environment `prod` may assume it, and it can only assume the CDK bootstrap roles and sign in to the public ECR |
| `SmartDoc-Prod-Cert` (us-east-1) | Certificate for `smartdoc.codemit.sk` |
| `SmartDoc-Prod-Network` | VPC (2 AZs: public, private, isolated), fck-nat instance, S3 gateway endpoint |
| `SmartDoc-Prod-Data` | Aurora (PG 17, pgvector, min 0 / max 2 ACU, 7-day backups, deletion protection), documents bucket |
| `SmartDoc-Prod-Auth` | Prod user pool (the callbacks are already parameterized in `infra/cdk/lib/config.ts`) |
| `SmartDoc-Prod-App` | api, ai and worker Lambdas; Function URLs; SQS and DLQ; CloudFront (SPA + `/api/*`); the migrations trigger; the hourly schedule |
| `SmartDoc-Prod-Ops` | Alarms (errors, DLQ depth, throttles, NAT instance status) and the AWS Budget |

**Function URLs need two permissions.** The spike returned 403 on every call until both were
granted:
- `lambda:InvokeFunctionUrl`;
- `lambda:InvokeFunction` limited by `lambda:InvokedViaFunctionUrl`.

CDK's `grantInvokeUrl` and the CloudFront OAC origin add only the first, so the second is added
explicitly:
- **CloudFront → api:** `addPermission` with `invokedViaFunctionUrl: true`;
- **api → ai:** a role policy statement.

[infra/cdk/lib/spike-stack.ts](../../infra/cdk/lib/spike-stack.ts) does both. Also give every log
group a retention, because log groups outlive `cdk destroy`.

**Check:** `cdk synth` and the snapshot tests pass; `cdk diff` against the account lists only new
resources.

### Step 3: First deploy by hand (≈ 1 h)

```bash
cd infra/cdk
npx cdk deploy SmartDoc-Ci --profile codemit
npx cdk deploy 'SmartDoc-Prod-*' --profile codemit
scripts/init-secrets.sh prod    # written in Step 2, as in randevu: asks for the OpenAI key
make invite STAGE=prod EMAIL=you@example.com ADMIN=1
```

Record secret *names* only (never values) in `docs/runbooks/prod-secrets.md`.

**Check:**
- `https://smartdoc.codemit.sk` signs in;
- a 20 MB PDF ingests;
- a question streams an answer with citations;
- `/api/health` is `ok`;
- `Bearer ey` appears 0 times in CloudWatch Logs.

### Step 4: Continuous deployment (≈ 1 h)

`.github/workflows/deploy.yml`, as in randevu:
- **Trigger:** `workflow_run` after CI succeeds on `main`, and `workflow_dispatch`.
- **Job:** environment `prod`, `concurrency: deploy-prod`, runner `ubuntu-24.04-arm`. The
  repository is public, so the native arm64 runner is free.
- **Steps:**
  1. web build;
  2. assume the OIDC role;
  3. `cdk deploy 'SmartDoc-Prod-*'`;
  4. smoke test: `/` contains `<div id="root">`, and `/api/health` reports the new version, with
     retries while Aurora resumes.

**Check:** a merge to `main` is live in ≈ 10 minutes, and "Run workflow" on an older green commit
rolls back.

### Step 5: Operations (≈ 1 h)

- **Restore drill:** Aurora backups are built in (7 days, point-in-time recovery). Restore into a
  new cluster and verify it as in [restore.md](restore.md); record the RTO.
- **Cost:** re-run the cost replay against prod and reconcile tokens with the OpenAI usage export
  (±2 %).
- **Housekeeping:** run `cdk gc` monthly, because the CDK asset repository keeps every old image.

### Pausing and removing

- **Pause** (keep the data, stop the fixed cost):
  - set the NAT instance's desired count to 0 (Aurora pauses by itself);
  - the site stays up, but answers fail until the NAT is back.
- **Remove:**
  1. `npx cdk destroy 'SmartDoc-Prod-*'`;
  2. Aurora leaves a final snapshot, and the protected buckets stay until deleted by hand;
  3. the `prod` Environment can stay: without a workflow it does nothing.

## App changes

What Step 1 has to deliver:

1. **Ingestion through SQS.** "Upload complete" sends one SQS message with the job id. The worker
   Lambda claims that job with the existing lease code (`SKIP LOCKED`, fenced state changes), so
   the Postgres queue stays the source of truth.
   - SQS retries 3 times, then moves the message to a DLQ with an alarm.
   - Locally the worker keeps polling, behind a `QUEUE_DRIVER` switch.
2. **No timers in the process.** `ChatHousekeeping` (`setInterval`) becomes a handler that
   EventBridge Scheduler calls hourly, and `reserve()` also releases expired reservations itself.
   Anything that touches the database more often than the auto-pause delay keeps Aurora awake
   (≈ $50 a month at its 0.5 ACU idle floor).
3. **Lambda entry points.**
   - The api and ai images run behind the Lambda Web Adapter with
     `AWS_LWA_INVOKE_MODE=response_stream`.
   - The api calls the ai Function URL with a SigV4-signed `fetch` instead of `http://ai:8000`.
   - The worker gets an SQS handler in the Python image.
4. **Connections.** Pools of 1–2 connections per Lambda instance, and reserved concurrency per
   function (api 10, ai 10, worker 2), so Aurora's connection limit cannot be reached.
5. **Cold starts.**
   - **Measured in the spike:** Node 0.8–1.0 s, Python 4.7 s. The real ai image imports more, so
     expect 5–8 s.
   - **Lazy imports help:** the PDF parser is needed only in the worker.
   - **Aurora** resumes from a pause in ≈ 15 s. `/api/health` answers `503` while it wakes up, and
     the web app shows "Waking up…" and retries.
6. **Secrets.** `smartdoc/prod/app` in Secrets Manager (OpenAI key, internal token), read at cold
   start. CDK generates the database secret.
7. **The browser** sends `x-amz-content-sha256` on every POST. CloudFront OAC with Function URLs
   requires it, and `sha256Hex` already exists in the web app.
8. **Migrations** run in a CDK `TriggerFunction` inside the VPC after every deploy whose image
   changed. A failed migration fails the deploy.

## Cost (estimate, demo traffic ≈ 6k answers a month)

| Item | Monthly |
|---|---|
| NAT instance (t4g.nano, public IPv4, 2 GB disk) | ≈ $7.3 |
| Aurora Serverless v2: billed only while awake, plus storage (≈ 1 GB) | ≈ $1–4 |
| Lambda, SQS, Scheduler, CloudFront | ≈ $0 (always-free tiers) |
| Secrets Manager (2), CloudWatch logs and alarms, ECR images | ≈ $1.5–2.5 |
| Route 53 | ≈ $0 (the zone is shared with codemit.sk) |
| **AWS total** | **≈ $10–14** (≈ $3 paused) |
| OpenAI | ≈ $1.2 (replay: $0.20 per 1k queries) |

## Risks

| Risk | Mitigation |
|---|---|
| The NAT instance is a single point of failure | Auto-recovery and a status alarm; demo traffic tolerates minutes of downtime |
| Aurora never pauses (a timer keeps it awake) | Hourly housekeeping only; the Budget alarm catches it within a day |
| Cold start + resume ≈ 20–25 s on the first request | "Waking up…" in the UI; open the app before a demo |
| Too many connections from Lambda | Small pools and reserved concurrency per function |
| Cost run-away | Per-user and global daily budgets (done), OpenAI hard limit, AWS Budget |
