# SmartDoc AI: product requirements

A portfolio product, specified like a real one: who it is for, what it must do, how well, and what
it deliberately does not do. Status per requirement is as of 2026-10-27.

## Problem

People in a company look for answers in long documents (a labour code, an internal handbook, a
security policy) and either read for twenty minutes or guess. A chatbot that answers from memory is
worse than guessing, because it sounds certain. The answer has to come **from the documents**, show
**where**, say **"not in the documents"** when that is the truth, and cost little enough that
nobody has to ration it.

## Personas

- **Employee:** uploads a few PDFs or uses shared ones, asks plain-language questions, checks the
  cited page before acting.
- **Admin / operator:** answers for the bill and the quality. Watches cost per answer and cache
  effectiveness, reads thumbs-downs, sets budgets.

## User stories

| # | Story | Acceptance criteria | Status |
|---|---|---|---|
| U1 | As an employee I upload a PDF and see when it is ready | PDFs up to 20 MB and 50 per user; progress while uploading; `queued → processing → ready` without reloading; a specific reason when it fails (no text layer, encrypted, too many pages) | done |
| U2 | I ask a question and get an answer that cites pages | the first token streams in; numbered citations that open the PDF at the page; sources with snippets | done |
| U3 | When the documents do not contain the answer, I am told so | the answer says it is not in the documents instead of inventing one; an irrelevant question may be refused without an LLM call | done (the gate still needs calibration) |
| U4 | I ask follow-up questions | "and how many of them…" is understood in the conversation's context | done |
| U5 | I rate an answer | thumbs up or down, reasons and a comment on a thumbs-down; changeable | done |
| U6 | I never see another user's documents | another user's ids answer 404 everywhere; retrieval never crosses tenants | done (tested) |
| U7 | I know my spending limit | today's spend in the header; a clear message and the reset time when the limit is reached | done |
| U8 | Deleting a document removes it | out of chat scope at once; its snippets disappear from past answers; its files are deleted | done |
| A1 | As an admin I see what the app costs | spend per day by purpose, cost per answer, cache hit rates, savings, the replay comparison | done |
| A2 | As an admin I review bad answers | the newest thumbs-downs with question, answer, reasons and request id | done |
| A3 | As an admin I change a user's budget | without a deploy | `make budget` from the laptop; no UI yet |

## Functional requirements

- **Documents:**
  - direct-to-S3 upload with a checksum;
  - duplicate detection (409);
  - asynchronous ingestion with retries and specific failure codes;
  - delete in any state.
- **Chat:**
  - streamed answers (SSE) over hybrid retrieval (vector + full text);
  - a relevance gate and an exact answer cache;
  - standalone rewrite of follow-ups;
  - idempotent sends;
  - a degraded mode (passages without generation) when OpenAI is down.
- **Cost:**
  - one ledger row per billed call;
  - per-user and app-wide daily budgets with reservations;
  - cost per answer shown on every answer.
- **Quality:**
  - an eval harness with golden, synthetic and injection datasets;
  - a deterministic tier in CI;
  - pre-registered claims.
- **Admin:**
  - the Cost page;
  - an API that reads the same ledger.

## Non-functional requirements

| Area | Target | Measured or status |
|---|---|---|
| Retrieval quality | Recall@5 ≥ 0.85, MRR ≥ 0.70 | dry run Hit@5 0.83, MRR 0.54 (unreviewed set); official numbers after the review |
| Refusals | refusal accuracy ≥ 0.90, false refusals ≤ 5 % | dry run 6 of 7, 7 of 33 |
| Citations | precision ≥ 0.80 | dry run 0.82 |
| Prompt injection | 0 of 12 canaries succeed | dry run 0 of 12 (95 % CI up to 24 %) |
| Tenant isolation | 0 cross-tenant retrievals | 0 of 100 probes; IDOR test over every `:id` route |
| Cost | uncached answered query ≤ $0.0005 | $0.00024 p50 (optimized arm of the replay) |
| Latency | time to first token p95 ≤ 3 s (warm) | answer p50 1.5 s, p95 2.7 s (dry run) |
| Availability (production design) | 99 % monthly for the demo | not deployed |
| Backups | RPO 5 min (production design), RTO ≤ 1 h | RTO 8–11 s locally ([runbooks/restore.md](runbooks/restore.md)) |
| Spend | per-user $0.25 a day by default; overshoot ≤ one reservation | enforced and tested |

## Out of scope

- shared workspaces and teams (every user is their own tenant);
- self sign-up (invite-only);
- formats other than PDF, scanned PDFs (no OCR) and languages other than English;
- a semantic cache (deferred until its false hits can be measured);
- mobile apps.

## What an enterprise would add

- **Identity:** SAML or OIDC federation with the company's identity provider (Cognito supports
  both).
- **Collaboration:** workspaces with roles (owner, editor, reader), and documents shared per
  workspace.
- **Audit:** an audit log of admin reads and budget changes, exportable.
- **Resilience:** multi-AZ Aurora with a reader, and an always-warm compute profile.
- **Data:** EU residency end to end (see below), retention controls per workspace, and deletion
  reports.
- **Isolation:** row-level security as a second line under the query-level tenancy.

## Privacy and data flows

| Data | Goes to | Retention |
|---|---|---|
| PDF bytes | S3 (eu-central-1), versioned | until deleted; old versions expire after 30 days |
| Chunks, embeddings, conversations, answers | Postgres (local; Aurora eu-central-1 in production) | until the user deletes them |
| Question text, retrieved passages, history | OpenAI Responses API, `store: false`, a hashed tenant id as `safety_identifier` | not stored by the app at OpenAI; OpenAI's abuse-monitoring retention applies |
| Document text for embeddings | OpenAI embeddings API | as above |
| Logs | local container logs (CloudWatch in production) | access tokens and presigned URLs are never logged |
| Cost ledger | Postgres | kept for reporting; holds no question text |

- **Residency.** The eval corpus is public law, so any processing location is acceptable for it.
  Production with customer documents would use:
  - OpenAI's EU data residency;
  - `store: false` (already set);
  - no prompt logging.
- **"Data must stay in AWS":** Amazon Bedrock is the alternative. The eval harness would measure
  the quality and cost difference before switching.

## Release plan

1. **Local MVP:** done.
2. **Production hardening:** done (tenancy tests, budgets, cache, CI, Cost page, restore drill).
3. **Quality baseline:** golden-set review → official eval table → gate calibration (Block 2.7).
4. **Public demo:** when wanted, following [deploy-prod.md](runbooks/deploy-prod.md) (≈ 1.5–2 days).

## Open questions

- The relevance gate threshold. The uncalibrated gate refused 0 of 7 unanswerable questions;
  2.7 decides τ.
- Whether the "no reasoning" setting costs quality. In the replay it doubled refusals (24 → 50
  of 238); the eval will tell whether those refusals were right.
- The admin budget UI (A3): worth building, or `make budget` is enough for a demo.
