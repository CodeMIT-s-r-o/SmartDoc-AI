# ADR-009: Compute and edge: Lambda in a VPC behind CloudFront, local only for now

- **Status:** accepted (production design); SmartDoc runs on localhost only until production is
  wanted
- **Date:** 2026-10-27

## Context

The [original plan](../planning/IMPLEMENTATION_PLAN.md) (§10) put everything on one EC2 t4g.small: Docker Compose,
Caddy and Postgres on an EBS volume, behind CloudFront. Two things changed:

1. **Cost.** The T4g free trial ends on 2026-12-31. From then on the instance, its public IPv4 and
   its disk cost ≈ $21 a month, whether anyone uses the demo or not.
2. **Consistency.** Two other CodeMIT projects (randevu, grosik) already run serverless in the same
   AWS account:
   - Lambda behind CloudFront, Aurora Serverless v2 that pauses when idle;
   - `cdk deploy` from GitHub Actions through OIDC;
   - the account already has the Route 53 zone, the GitHub OIDC provider and the CDK bootstrap.

SmartDoc differs from both projects in two ways:
- **It streams answers over SSE**, and grosik avoids streaming by polling.
- **Its AI service is Python** with psycopg.

## Decision

1. **Production design:** CloudFront (SPA from S3, `/api/*` to a Lambda Function URL), three
   Lambda functions in a VPC (api, ai, ingest worker), Aurora Serverless v2 with pgvector reached
   directly, and a NAT instance (fck-nat, t4g.nano) for outbound calls. The full design and procedure
   are in [deploy-prod.md](../runbooks/deploy-prod.md).
2. **VPC + NAT instead of the Data API** that randevu and grosik use. The app keeps psycopg and
   node-postgres, with transactions, `SET LOCAL hnsw.*`, `executemany` and the pgvector adapters.
   A Data API layer in both services would cost about a day more of work.
3. **Not deployed for now.** The repository has CI only, with no AWS credentials. AWS holds only the
   dev Cognito pool and documents bucket that the local stack uses.

### Options considered

| Option | Monthly (demo traffic) | Notes |
|---|---|---|
| Single EC2 + Compose (original plan) | ≈ $7 until 2026-12-31, then ≈ $21 | always on; OS, Docker and Caddy to run |
| Lambda + Aurora via Data API (randevu, grosik) | ≈ $3–7 | rewrite of the DB layer in Python and NestJS |
| **Lambda in a VPC + NAT instance** | **≈ $10–14** | the drivers stay; the NAT instance is the only always-on part |
| Lambda in a VPC + NAT Gateway | ≈ $45+ | too expensive for a demo |
| Lambda in a VPC + IPv6-only egress | ≈ $3–7 | every endpoint has an AAAA record; client fallback untested |

## Evidence

**Streaming spike** (2026-10-27, [infra/spike/](../../infra/spike/)): SSE went through CloudFront →
Node Function URL → Python Function URL, both behind the Lambda Web Adapter in response-streaming
mode.

| Check | Result |
|---|---|
| Events | 90 of 90 on three concurrent 90 s streams; at most 1.0 s between events (no buffering) |
| Time to first byte, warm | 130–320 ms |
| Time to first byte, cold | 6.6 s (Python init 4.7 s) |
| Function URL without CloudFront | 403 |

- **New Function URLs need two permissions:** `lambda:InvokeFunctionUrl` plus `lambda:InvokeFunction`
  (via the URL). Without both, every call returned 403.
- **Restore drill** (2026-10-27): RTO 8–11 s locally, all 17 tables equal
  ([runbooks/restore.md](../runbooks/restore.md)).

## Consequences

- **Positive:**
  - no server to patch, and no cost when idle except the NAT instance;
  - the edge, CI role, certificate stack and deploy workflow follow randevu and grosik;
  - arm64 everywhere: a Mac laptop, Graviton Lambdas, and GitHub's free native arm64 runners (the
    repository is public).
- **Negative:**
  - **cold starts:** ≈ 20–25 s for the first request after a pause, with Aurora resuming;
  - **the NAT instance** is a single point of failure for outbound calls;
  - **app changes before the first deploy:** SQS-triggered ingestion, hourly housekeeping from
    EventBridge, Lambda entry points, and connection limits.
- **RPO/RTO in production:**
  - **RPO:** 5 minutes, from Aurora point-in-time recovery.
  - **RTO:** under 1 hour; the procedure is in the restore runbook.
- **Revisit:**
  - if the demo needs to be always warm: provisioned concurrency, or Fargate (≈ $30 a month);
  - if outbound traffic grows past what one t4g.nano carries;
  - if the IPv6 spike passes: it would remove the NAT instance.
