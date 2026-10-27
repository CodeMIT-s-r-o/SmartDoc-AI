# ADR-002: Postgres + pgvector as the only data store

- **Status:** accepted
- **Date:** 2026-09-25 (decided), 2026-10-27 (written up with measurements)

## Context

SmartDoc needs relational data (users, documents, conversations, the cost ledger, budgets), vectors
for semantic search, full-text search for exact terms (section numbers, defined words in legal
text), and a job queue. Tenant isolation must hold in every one of them. A demo runs a few documents
per user; the design must still say where it stops scaling.

## Decision

- **One Postgres database** holds everything:
  - `chunks.embedding` is `halfvec(1536)` (text-embedding-3-small, half precision);
  - `chunks.tsv` is a generated `tsvector` with a GIN index;
  - the queue is a table ([ADR-006](006-job-queue.md)).
- **Vector index:** HNSW, `halfvec_cosine_ops`, `m = 16`, `ef_construction = 64`. Queries set
  `hnsw.ef_search = 100` and `hnsw.iterative_scan = relaxed_order`, so a tenant filter cannot
  starve the result set.
- **Hybrid retrieval is one SQL statement:** a vector branch and a keyword branch (40 candidates
  each), fused with Reciprocal Rank Fusion (k = 60), ties broken by id so results do not depend on
  physical row order. Tenant and document scope are `WHERE` clauses in both branches, in the same
  query that a test proves cannot cross tenants.
- **No separate vector database** (Pinecone, Qdrant, OpenSearch). One transaction covers a
  document's chunks, its status and its job, and deleting a document removes its vectors with it.

## Measurements (2026-10-27, eval corpus: 5 acts, 1,002 chunks)

| | Measured | Planned estimate |
|---|---|---|
| Embedding (`pg_column_size`) | 3,076 B | 3,080 B |
| HNSW index per vector | 4,104 B | 3.3–3.5 KB |
| GIN (full text) per chunk | 1,897 B | |
| Whole table per chunk (heap, TOAST, all indexes) | **11.9 KB** | 9–10 KB |
| Retrieval latency over 190 questions, warm | **p50 18.8 ms, p95 64.1 ms** | switch point: p95 > 100 ms |

- **At 1,002 chunks the planner does not use the HNSW index.** `EXPLAIN ANALYZE` shows a sequential
  scan, which is exact and cheaper at this size. The index starts to pay off as the table grows.
  EXPLAIN at 50k synthetic chunks is the open measurement that would show the switch.
- **The restore drill rebuilt both indexes** in about 2 s
  ([runbooks/restore.md](../runbooks/restore.md)).

## Capacity and switch points

| Chunks | Size (≈ 11.9 KB each) | Fits |
|---|---|---|
| 1k | 12 MB | anything |
| 50k | ≈ 0.6 GB (HNSW ≈ 200 MB in page cache) | a small instance or Aurora at 1–2 ACU |
| 600k | ≈ 7 GB | a dedicated 16 GB database host |

Move to per-tenant partitioning or a dedicated vector engine when one of these holds:
- above ≈ 10M vectors;
- retrieval p95 above 100 ms;
- selective filters hit `hnsw.max_scan_tuples` (20k) and recall drops.

## Consequences

- **Positive:**
  - one backup, one restore, one set of credentials;
  - transactional consistency between vectors and their documents;
  - tenant scope enforced by SQL that the IDOR test covers.
- **Negative:**
  - vector search shares CPU and memory with everything else;
  - HNSW build time grows with the data;
  - the HNSW index is created by a hand-written migration, because drizzle-kit renders vector
    operator classes unreliably.
- **Reversal:** the retrieval function takes a scope and returns ranked candidates, so a different
  store can replace the SQL behind it. The eval harness measures the change.
