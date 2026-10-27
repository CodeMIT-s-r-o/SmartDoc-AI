# Documentation

## Where to start

| You want to… | Read |
|---|---|
| Understand the system | [ARCHITECTURE.md](ARCHITECTURE.md), then the [ADRs](adr/) |
| Know what it does and how well | [PRD.md](PRD.md): user stories, requirements with their measured status |
| Present it or answer questions about it | [INTERVIEW.md](INTERVIEW.md) |
| Call the API | [openapi.yaml](openapi.yaml) (OpenAPI 3.1, tested against the mounted routes) |
| See how it was built, block by block | [BUILD_LOG.md](BUILD_LOG.md) |
| Compare with the original plan | [planning/](planning/) (archived, not maintained) |

## Runbooks

| Procedure | When |
|---|---|
| [dev-aws.md](runbooks/dev-aws.md) | One-time setup of the dev AWS resources, and `make creds` every day |
| [golden-review.md](runbooks/golden-review.md) | Before any official quality number: review the 40 golden items against the PDFs |
| [calibration.md](runbooks/calibration.md) | After the review: calibrate the relevance gate, test the claims, publish the eval table (Block 2.7) |
| [deploy-prod.md](runbooks/deploy-prod.md) | When production is wanted: smartdoc.codemit.sk on Lambda and Aurora, step by step |
| [restore.md](runbooks/restore.md) | Restore the database from a backup; `make restore-drill` tests it |

## Decisions (ADRs)

| # | Decision |
|---|---|
| [001](adr/001-service-split.md) | A NestJS API and a Python AI service |
| [002](adr/002-pgvector-single-store.md) | Postgres + pgvector as the only data store |
| [003](adr/003-thin-ai-stack.md) | No LangChain or LlamaIndex chains and no vector store library |
| [004](adr/004-prompt-caching.md) | Explicit prompt caching with a static prefix |
| [005](adr/005-gate-and-answer-cache.md) | Relevance gate and exact answer cache |
| [006](adr/006-job-queue.md) | Ingestion queue in Postgres |
| [007](adr/007-streaming.md) | SSE over POST, passed through the API |
| [008](adr/008-cost-ledger.md) | Cost ledger and budgets with reservations |
| [009](adr/009-compute-and-edge.md) | Production design: Lambda in a VPC behind CloudFront; local only for now |
| [010](adr/010-eval-strategy.md) | Eval strategy: a deterministic CI tier, a live tier, pre-registered claims |

## Elsewhere in the repository

- [eval/corpus/README.md](../eval/corpus/README.md): how to get the eval corpus PDFs.
- [eval/corpus/LICENSES.md](../eval/corpus/LICENSES.md): why the corpus may be used.
- `eval/claims.yaml`: the pre-registered claims.
- `eval/thresholds.yaml`: the quality gates.
- [infra/spike/README.md](../infra/spike/README.md): the streaming spike behind the production
  design.
