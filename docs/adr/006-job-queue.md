# ADR-006: Ingestion queue in Postgres

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Ingestion (parse, chunk, embed) takes seconds to minutes and must survive worker crashes, poison
PDFs and transient OpenAI or S3 failures. The deployment is one EC2 instance with Postgres
already running; every extra service costs RAM and operations time.

## Decision

- **The queue is a table, `ingestion_jobs`.** `/complete` inserts the job in the same transaction
  that moves the document to `queued` (outbox), so a document can never be queued without a job.
- **Claiming:** `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`, polled every
  2 s. `attempts` is incremented at claim time, so a job that keeps killing its worker (OOM) still
  runs out of attempts.
- **Leases and fencing:** the claim sets `locked_at` and a fresh `lease_token`. A running job whose
  lease is older than 15 minutes is reclaimed. Every later write (stage, retry, fail, finalize)
  checks the token, so a worker that lost its lease can never commit results.
- **Failures:** permanent codes (NO_TEXT_LAYER, ENCRYPTED, TOO_MANY_PAGES, PARSE_LIMIT_EXCEEDED,
  INVALID_PDF) fail at once; anything else retries after 30 s * 2^attempts, at most 3 attempts.
- **Finalize is one fenced transaction:** close the job, replace the chunks, mark the document
  `ready` only if it is still `processing` (a concurrent delete rolls everything back).

## Consequences

- **Positive:** no new infrastructure; job state and document state change atomically; the
  behaviour is testable against a real database (10 queue tests, including concurrent claims).
- **Negative:** polling adds up to 2 s of latency and a trivial query every 2 s per worker; one
  job at a time per worker.
- **Measured:** a 102-page PDF goes from `queued` to `ready` in about 6 s.
- **Upgrade path:** `LISTEN/NOTIFY` removes the polling latency; SQS (with the same idempotent
  finalize) when ingestion moves off the single instance.
