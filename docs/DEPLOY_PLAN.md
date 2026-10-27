# Deployment plan: smartdoc.codemit.sk

**Decision (2026-10-27): SmartDoc runs on localhost only.** Nothing is deployed and nothing
deploys by itself:
- **GitHub:** the only workflow is CI (`ci.yml`: lint, types, tests, DB tests, offline eval,
  gitleaks). It has no AWS credentials, no `id-token` permission and no secrets.
- **AWS:** only the two dev stacks the local stack needs (Cognito and the documents bucket).

This file is the plan for the day production is wanted, and the [procedure](#how-to-deploy) to
get there.

## What exists today

| Where | What | Why |
|---|---|---|
| AWS `SmartDoc-Dev-Auth` | Cognito user pool, PKCE client, `admin` group | Sign-in on localhost |
| AWS `SmartDoc-Dev-Storage` | `smartdoc-dev-docs-…` bucket, the `SmartDocDevApp` role | Uploads and PDF links on localhost (`make creds`) |
| AWS SSM | `/smartdoc/dev/config/*` | Settings the local stack reads |
| GitHub | `ci.yml`, Environment `prod` restricted to `main` | CI; the environment is unused until a deploy workflow exists |
| Shared with randevu and grosik | Route 53 zone `codemit.sk`, GitHub OIDC provider, CDK bootstrap in eu-central-1 and us-east-1 | Ready for Step 2, nothing to create |

Removed after the streaming spike: the `SmartDoc-Spike` stack, its log groups and its two images in
the CDK asset repository that randevu and grosik share. Nothing from the spike is left in AWS.

## Target: Lambda in a VPC with a NAT instance

The same edge and deploy pipeline as randevu and grosik, with one difference: the Lambdas run inside
a VPC and talk to Aurora directly. The app keeps its Postgres drivers (psycopg, node-postgres),
so no Data API rewrite is needed.

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

### Why VPC + NAT

| Option | Extra cost a month | App changes | Verified |
|---|---|---|---|
| **VPC + NAT instance (chosen)** | ≈ $7.3 (t4g.nano $3.5 + public IPv4 $3.65 + disk) | small: the drivers stay | the standard pattern |
| Data API, no VPC (randevu, grosik) | $0 | a Data API layer in Python and NestJS (≈ 1 extra day) | in the other projects |
| VPC + NAT Gateway | ≈ $38 + $0.052/GB | small | standard, but too expensive for a demo |
| VPC + IPv6 egress only | $0 | small | **no**: every endpoint has an AAAA record, but the clients' IPv4 fallback is untested |

The NAT instance is the only always-on part. Everything else is paid per use. If cost matters more
than effort later, the IPv6 option is a one-hour spike away (the endpoints were checked on
2026-10-27: api.openai.com, cognito-idp, secretsmanager and sqs all resolve to IPv6).

### What the app needs before it can run in Lambda

1. **Ingestion through SQS.** "Upload complete" sends one SQS message with the job id. The worker
   Lambda claims that job with the existing lease code (`SKIP LOCKED`, fenced state changes), so
   the Postgres queue stays the source of truth. SQS retries 3 times, then moves the message to a
   DLQ with an alarm. Locally the worker keeps polling, behind a `QUEUE_DRIVER` switch.
2. **No timers in the process.** `ChatHousekeeping` (`setInterval`) becomes a handler that
   EventBridge Scheduler calls hourly, and `reserve()` also releases expired reservations itself.
   Anything that touches the database more often than the auto-pause delay keeps Aurora awake
   (≈ $50 a month at its 0.5 ACU idle floor).
3. **Lambda entry points.** The api and ai images run behind the Lambda Web Adapter with
   `AWS_LWA_INVOKE_MODE=response_stream`. The api calls the ai Function URL with a SigV4-signed
   `fetch` instead of `http://ai:8000`. The worker gets an SQS handler in the Python image.
4. **Connections.** Pools of 1–2 connections per Lambda instance and reserved concurrency per
   function (api 10, ai 10, worker 2), so Aurora's connection limit cannot be reached. RDS Proxy is
   not needed at this scale.
5. **Cold starts.** Measured in the spike: Node 0.8–1.0 s, Python 4.7 s. The real ai image imports
   more, so expect 5–8 s; lazy imports help (the PDF parser is only for the worker). Aurora resumes
   from a pause in ≈ 15 s.
   - `/api/health` answers `503` while the database wakes up.
   - The web app shows "Waking up…" and retries.
6. **Secrets.** `smartdoc/prod/app` in Secrets Manager (OpenAI key, internal token), read at cold
   start. CDK generates the database secret.
7. **The browser** sends `x-amz-content-sha256` on every POST (CloudFront OAC with Function URLs
   requires it; `sha256Hex` already exists in the web app).
8. **Migrations** run in a CDK `TriggerFunction` inside the VPC after every deploy whose image
   changed. A failed migration fails the deploy.

## Phase 1: streaming spike: passed

**Date and code:** 2026-10-27, [infra/spike/](../infra/spike/). Three concurrent 90 s SSE streams
went through CloudFront → Node Function URL → Python Function URL. Both functions run behind the
Lambda Web Adapter 1.0.0 in response-streaming mode.

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
  - for CloudFront → api: `addPermission` with `invokedViaFunctionUrl: true`;
  - for api → ai: a role policy statement.

  See [lib/spike-stack.ts](../infra/cdk/lib/spike-stack.ts). randevu and grosik do not need this
  because their URLs are older.
- **Log groups outlive `cdk destroy`.** The stacks set a retention, and outside prod a removal
  policy of `DESTROY`.

The spike ran outside a VPC. Moving the functions into a VPC changes their outbound path only;
CloudFront still reaches the Function URLs the same way.

## How to deploy

The steps in order, each with the check that must pass before the next. Total ≈ 1.5–2 days.

### Step 0: Decide and prepare (you, 30 min)

- [x] An OpenAI project `smartdoc-prod` with an *enforced* monthly hard limit and its own key
      (2026-10-27).
- [x] GitHub Environment `prod`, restricted to `main` (2026-10-27).
- [ ] The monthly AWS budget for SmartDoc (suggested $20) and the e-mail for its alerts.

### Step 1: App changes (≈ 0.5–1 day, one PR)

Items 1–8 of [What the app needs](#what-the-app-needs-before-it-can-run-in-lambda). Each one sits
behind a switch, so `make up`, the tests and CI stay as they are.

**Check:** `make check`, `make test-db` and `make eval-ci` are green, and the local stack still
works end to end.

### Step 2: Stacks (≈ 4 h, one PR)

Copy and adapt from randevu and grosik: `config.ts`, `zone.ts`, `ci-stack.ts`, `cert-stack.ts`,
`images.ts`, `site.ts` (CSP). Add snapshot tests next to the existing ones.

| Stack | Contents |
|---|---|
| `SmartDoc-Ci` (deployed once, by hand) | The role `smartdoc-github-deploy`: only this repository in the Environment `prod`, only the CDK bootstrap roles and a public ECR sign-in |
| `SmartDoc-Prod-Cert` (us-east-1) | Certificate for `smartdoc.codemit.sk` |
| `SmartDoc-Prod-Network` | VPC (2 AZs: public, private, isolated), fck-nat instance, S3 gateway endpoint |
| `SmartDoc-Prod-Data` | Aurora (PG 17, pgvector, min 0 / max 2 ACU, 7-day backups, deletion protection), documents bucket |
| `SmartDoc-Prod-Auth` | Prod user pool (callbacks already parameterized in `config.ts`) |
| `SmartDoc-Prod-App` | api, ai and worker Lambdas, Function URLs with both invoke permissions, SQS and DLQ, CloudFront (SPA + `/api/*`), migrations trigger, hourly schedule |
| `SmartDoc-Prod-Ops` | Alarms (errors, DLQ depth, throttles, NAT instance status) and the AWS Budget |

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

**Check:**
- `https://smartdoc.codemit.sk` signs in;
- a 20 MB PDF ingests;
- a question streams an answer with citations;
- `/api/health` is `ok`;
- `Bearer ey` appears 0 times in CloudWatch Logs.

### Step 4: Continuous deployment (≈ 1 h)

`.github/workflows/deploy.yml` as in randevu:
- **Trigger:** `workflow_run` after CI succeeds on `main`, and `workflow_dispatch`.
- **Job:** environment `prod`, `concurrency: deploy-prod`, runner `ubuntu-24.04-arm`. The
  repository is public, so the native arm64 runner is free.
- **Steps:**
  1. web build;
  2. OIDC role;
  3. `cdk deploy 'SmartDoc-Prod-*'`;
  4. smoke test: `/` has `<div id="root">`, and `/api/health` reports the new version, with
     retries while Aurora resumes.

**Check:** a merge to `main` is live in ≈ 10 minutes; "Run workflow" on an older green commit
rolls back.

### Step 5: Operations (≈ 1 h)

- **Restore drill:** Aurora backups are built in (7 days, point-in-time). Restore into a new
  cluster, compare row counts and record the RTO.
- **Measurements:** re-run the cost replay against prod and reconcile tokens with the OpenAI usage
  export (±2 %).
- **Housekeeping:** `cdk gc` monthly, because the CDK asset repository keeps every old image.

### Pausing and removing

- **Pause** (keep the data, stop the fixed cost):
  - set the NAT instance's desired count to 0 (Aurora already pauses by itself);
  - the site stays up, but answers fail until the NAT is back.
- **Remove:**
  1. `npx cdk destroy 'SmartDoc-Prod-*'`;
  2. Aurora leaves a final snapshot, and the protected buckets stay until deleted by hand;
  3. delete the `prod` Environment, or leave it: without a workflow it does nothing.

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
