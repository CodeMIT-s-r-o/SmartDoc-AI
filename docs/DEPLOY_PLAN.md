# Deployment plan: smartdoc.codemit.sk

How the working local stack becomes a public demo. The target architecture is
[IMPLEMENTATION_PLAN.md §10](IMPLEMENTATION_PLAN.md#10-aws-infrastructure); this file is the
executable order of work, what is already done, and what has changed since that section was
written. It covers Blocks 2.2 (deploy spike) and 2.3 (CI/CD and the real app).

## Target in one picture

```text
browser ──► CloudFront (smartdoc.codemit.sk, ACM cert in us-east-1, WAF on the flat-rate Free plan)
             ├─ default  ──► S3 SPA bucket (OAC; CloudFront Functions: SPA rewrite, CSP header)
             └─ /api/*   ──► origin.smartdoc.codemit.sk:443  (adds X-Origin-Verify)
                              EC2 t4g.small, public subnet, SG = CloudFront prefix list only
                              Caddy (Let's Encrypt) ─► api ─► ai / ai-worker ─► Postgres on /data
                              Cognito (prod pool), S3 docs bucket, SSM secrets, CloudWatch
```

## Status

| Piece | State |
|---|---|
| Dev Storage + Auth stacks (CDK) | done, deployed (Block 1.2) |
| App: upload, ingest, chat, budgets, cache, dedup | done, local stack |
| CI (`.github/workflows/ci.yml`): lint, types, tests, DB tests, offline eval, gitleaks | done (this PR) |
| Prod stacks: Ci, Prod-Storage, Prod-Auth, Prod-Compute, Prod-Edge | to build |
| Production compose, Caddyfile, `deploy.sh`, `render-env.sh`, Dockerfile prod stages | to build |
| `deploy.yml` (images, release, SSM deploy, smoke test, SPA upload) | to build |
| Backups + restore runbook (tested once, RTO recorded) | to build |

## Prerequisites (Block 0.1, only you can do these)

- [ ] **AWS account eligibility for the CloudFront flat-rate Free plan** (an account on the Free
      Tier *plan* is not eligible). If not eligible: pay-as-you-go CloudFront without WAF (see risks).
- [ ] **DNS for codemit.sk:** confirm the zone is a Route 53 hosted zone in this account (the
      stacks create `smartdoc` and `origin.smartdoc` records and validate the ACM certificate by
      DNS) and that it has room (≤ 50 records counted for the plan).
- [ ] **CDK bootstrap in us-east-1** as well (`cdk bootstrap aws://ACCOUNT/us-east-1`): the
      certificate, WAF and edge stack live there.
- [ ] **OpenAI project `smartdoc-prod`** with an *enforced* monthly hard limit ($20) and its own
      key; a $10–20 prepaid balance.
- [ ] **Billing alerts e-mail** for the SNS topic (AWS Budget $25, anomaly monitor).
- [ ] **Decision: ARM image builds** (below).

## Decisions to make first

1. **Where arm64 images are built.** The instance is Graviton (t4g, arm64). GitHub's hosted arm64
   runners are free for public repositories only; this repository is private.
   - **a) Build arm64 under QEMU on the x86 runner** *(recommended)*: no cost, ~3–5× slower builds
     (estimate: 6–10 minutes per deploy with the `gha` layer cache).
   - b) Make the repository public: free native arm64 runners, and it is a portfolio project
     anyway. Needs a check that nothing private is in the history (`make secrets` is clean today).
   - c) x86 instance (t3a.small, ~$14/month, no free trial): native builds, but loses the T4g
     trial that makes the instance free until 2026-12-31.
2. **Public demo access.** Invite-only as planned (Cognito, no sign-up). A shared demo account for
   interviews, with a low daily budget (`make budget`), is the simplest way to let someone try it.
3. **Langfuse.** Cut-if-behind in the plan; the deploy works without it (Postgres telemetry and
   `request_id` cover the basics). Decide before writing the prod config.

## Order of work

Each phase ends in a check that must pass before the next one starts.

### Phase 1: Prod infrastructure, without the app (≈ 3 h)

1. CDK stacks in the order Ci → Prod-Storage → Prod-Auth → Prod-Compute → Prod-Edge
   (`infra/cdk/lib/`), with snapshot tests next to the existing ones:
   - **Ci:** GitHub OIDC provider and the `GhDeploy` role, trusted only for
     `repo:CodeMIT-s-r-o/SmartDoc-AI:environment:production`.
   - **Prod-Storage:** docs, backups and artifacts buckets; ECR repositories (immutable tags,
     scan on push, keep 10). Termination protection, retained buckets.
   - **Prod-Auth:** the prod user pool with `smartdoc.codemit.sk` callbacks (already parameterized
     in `config.ts`; the test "never mentions localhost in prod" exists).
   - **Prod-Compute:** VPC without NAT, SG from the CloudFront origin-facing prefix list (+80 for
     ACME), t4g.small with IMDSv2, a 10 GiB encrypted `/data` volume, EIP,
     `origin.smartdoc.codemit.sk`, the `SmartDoc-Deploy` SSM document, alarms and the $25 budget.
   - **Prod-Edge (us-east-1):** certificate, WAF, SPA bucket with OAC, CloudFront Functions
     (SPA rewrite, CSP), `/api/*` behavior with the origin-verify header, health check.
2. Secrets by hand in SSM (`/smartdoc/prod/secret/*` SecureStrings; the origin-verify String in
   us-east-1), recorded in `docs/runbooks/prod-secrets.md` (names only, never values).
3. Subscribe the flat-rate Free plan in the console (`docs/runbooks/cloudfront-plan.md`).

**Check:** `cdk diff` clean after deploy; the instance is reachable only through SSM Session
Manager; `curl https://origin.smartdoc.codemit.sk` from the internet times out (SG).

### Phase 2: Deploy spike with a hello-world stack (≈ 1 h)

1. `deploy/compose.prod.yml` with Caddy and a 40-line SSE endpoint that streams for 90 s.
2. Caddy on the Let's Encrypt **staging** CA first (5 duplicate certificates per week on
   production), then production.

**Check** (the risky parts of the architecture, before any real code depends on them):
- a 90-second SSE stream through CloudFront is not cut, with events arriving as sent;
- a request without `X-Origin-Verify` gets 403, and the header never reaches the app;
- the `X-Forwarded-For` chain gives the client IP to the app (throttling by user still works);
- the CSP header is present and the Cognito login still works with it.

### Phase 3: Real app and continuous deployment (≈ 3 h)

1. Production Dockerfile stages (`api`, `ai`, `web` build) and `deploy/compose.prod.yml` with the
   memory limits of §10 (db 512m, api 256m, ai 256m, ai-worker 448m, caddy 48m), restart
   policies, healthchecks and `stop_grace_period: 30s`; graceful shutdown in NestJS and uvicorn.
2. `render-env.sh` (SSM → env files on the instance) and `deploy.sh` (pull images, pre-deploy
   `pg_dump` to S3, migrate, `up -d --wait`, prune).
3. `deploy.yml`: on push to `main` after CI passes; environment `production`, `concurrency:
   production`; OIDC → build and push images tagged with the commit SHA → upload `deploy/` to
   the artifacts bucket → `ssm send-command SmartDoc-Deploy sha=…` → poll → smoke test. The web
   job builds the SPA with `VITE_*` from SSM, syncs it with immutable caching, and invalidates
   `index.html` only.
4. Prod Cognito: invite yourself (`make invite` against the prod pool); budgets per user.

**Check:**
- merge to `main` → live in under 15 minutes;
- smoke test: `/api/health`, an SSE answer end to end, and the log grep for `Bearer ey` finds 0;
- `docker stats` recorded during a 20 MB ingest + a chat + a deploy at the same time
  (expected steady state 1.0–1.2 GiB; resize trigger: memory > 85 % for 1 h);
- one rollback exercised (redeploy the previous SHA).

### Phase 4: Operations (≈ 1 h)

1. Nightly `pg_dump -Fc` to the backups bucket (35-day expiry) via a systemd timer.
2. `docs/runbooks/restore.md`, tested once: restore into a scratch Postgres, compare row counts,
   **record the RTO** (Block 2.9).
3. CPU credits back to `STANDARD` after the build weekend; alarms subscribed.

## Cost

| | Monthly |
|---|---|
| AWS with the T4g free trial (until 2026-12-31) | ≈ $7.3 (EBS $2.86, IPv4 $3.65, S3/ECR, Route 53) |
| AWS at list price (from 2027) | ≈ $21.3 |
| OpenAI demo traffic (≈ 6k answers) | ≈ $2.5 (measured: $0.0002–0.0004 per answer) |
| Paused (off-season: `pg_dump`, destroy Compute) | ≈ $1 |

## Risks

| Risk | Mitigation |
|---|---|
| Account not eligible for the flat-rate plan | Pay-as-you-go CloudFront (1 TB free), no WAF; rely on the throttler, budgets and the origin secret |
| SSE buffered or cut by CloudFront | Phase 2 spike proves it with a 90 s stream before the app depends on it |
| 2 GiB RAM too tight | Limits per container; the worker dies first (`oom_score_adj`), its job lease is reclaimed; t4g.medium by stop/start |
| QEMU builds slow | `gha` layer cache; only changed images are rebuilt |
| Let's Encrypt rate limit | Staging CA until the flow works |
| Cost run-away | Per-user and global daily budgets (done), OpenAI hard limit, AWS Budget + anomaly monitor |
