# ADR-003: A thin AI stack instead of LangChain or LlamaIndex chains

- **Status:** accepted
- **Date:** 2026-09-28

## Context

The author's first idea was LangChain. The parts of this system worth showing in an interview
are exactly the ones a framework would hide: tenant-scoped hybrid retrieval, the retrieval gate,
cache-aware prompt layout, and per-call cost accounting. The schema is owned by NestJS (Drizzle).

## Decision

- Official `openai` SDK for embeddings and the Responses API (streaming, prompt-cache options,
  usage fields).
- Plain SQL through psycopg 3 + pgvector for retrieval and the queue; no framework vector store
  (they create their own tables or impose their own filter language).
- From LangChain, only `langchain-text-splitters` (the recursive splitter).
- RAGAS (which pulls in LangChain) lives only in the eval project, never in the service image.

## Consequences

- **Positive:** every token and every SQL clause is visible and testable; the hybrid query is
  one statement that can be EXPLAINed; the prompt is byte-stable for caching; costs come straight
  from OpenAI's usage payload into the ledger.
- **Negative:** retries, streaming parsing and prompt assembly are our code to maintain.
- **Evidence:** even the one borrowed component needed care: `add_start_index` subtracts the
  overlap in characters while the splitter's overlap is in tokens, which would have shifted page
  citations (found by a test, replaced by our own offset lookup).
