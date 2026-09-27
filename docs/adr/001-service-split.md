# ADR-001: Separate Python AI service behind a NestJS API

- **Status:** accepted
- **Date:** 2026-09-26

## Context

SmartDoc AI needs a public API (auth, tenancy, uploads, budgets, streaming) and an AI pipeline
(PDF parsing, chunking, embeddings, retrieval, generation, evaluation). The author is fluent in
TypeScript; the Python ecosystem is stronger for document parsing and RAG evaluation (RAGAS).

## Decision

- **`api` (NestJS, TypeScript)** owns the public REST API, Cognito JWT verification, tenancy,
  S3 presigning, budgets and SSE pass-through. It owns the database schema (Drizzle migrations)
  and is the only service with AWS credentials.
- **`ai` + `ai-worker` (FastAPI, Python)** own ingestion and RAG. They are reachable only on the
  internal network, authenticated with a shared `X-Internal-Token`, and re-verify tenant scope in
  every query.
- **Eval parity:** the offline eval harness imports the same Python retrieval and generation code
  in-process, so README numbers describe the production code path.

## Consequences

- **Positive:** each language does what it is best at; ingestion can scale separately from the API;
  a compromised Python container holds no AWS credentials.
- **Negative:** two toolchains (Yarn + uv), an internal HTTP hop on every chat turn, a schema
  contract to guard (Drizzle owns it, Python reads it: `tests/test_schema_contract.py`, Block 1.3),
  and more RAM on a single small instance.
- **Measurements to add:** internal hop latency p50/p95 (Block 1.7) and steady-state RAM per
  container in production (Block 2.3).

## Reversal condition

If the eval harness moves out of Python or ingestion stops needing Python libraries, fold chat and
retrieval into NestJS and keep only the worker in Python (or drop it).

## Runtime choices (Block 0.3)

- **NestJS 12.1.0 (ESM-only)** passed the 20-minute timebox (build, Vitest e2e, Drizzle query), so
  the fallback to 11.2.x is not needed. Tests use Vitest with `unplugin-swc` for decorator metadata.
- **TypeScript 6.0.x**, not 7.0: the Nest CLI and typescript-eslint do not support 7 yet.
- **Python 3.13**, not 3.14: RAGAS 0.4.3 depends on packages without cp314 wheels.
