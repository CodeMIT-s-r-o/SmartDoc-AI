# Planning archive

How SmartDoc was planned before any code existed (2026-09-25), **kept as it was, not maintained**.
It is useful for seeing what was planned against what was built; it is not a description of the
current system.

**For the current state, read:**
- [ARCHITECTURE.md](../ARCHITECTURE.md) (the system as built);
- the [ADRs](../adr/) (the decisions);
- the [build log](../BUILD_LOG.md) (planned against actual, with measurements);
- the [runbooks](../runbooks/) (procedures).

| File | What it is |
|---|---|
| [PLAN_SUMMARY.md](PLAN_SUMMARY.md) | The condensed plan: fixed decisions, architecture, schedule, verification |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | The full v2 plan: SQL, flows, the API and SSE contracts, the eval design, the threat table, the interview Q&A. Source code comments still cite its sections |
| [draft-plan-v1.md](draft-plan-v1.md) | The first draft, before the reviews |
| [research/](research/) | Research with sources: LLM cost, the Python stack, AWS, evaluation and observability |
| [reviews/](reviews/) | Three adversarial reviews of the draft: interviewer, security and correctness, feasibility and cost |

**What changed after planning** (each one recorded in the build log):

| Planned | Built |
|---|---|
| Deployment on one EC2 instance with Compose and Caddy | SmartDoc runs locally only; the production design is Lambda in a VPC with a NAT instance and Aurora Serverless v2 ([deploy-prod.md](../runbooks/deploy-prod.md), [ADR-009](../adr/009-compute-and-edge.md)) |
| OpenAPI from `@nestjs/swagger` | A hand-written [openapi.yaml](../openapi.yaml), tested against the mounted routes |
| A US document corpus | Five Slovak acts in English translation ([ADR-010](../adr/010-eval-strategy.md)) |
| Langfuse traces | Not set up; the Postgres ledger and request tables are the source of truth |
| Not built | `POST /api/documents/:id/retry`, `GET /api/admin/requests`, the admin users API |
