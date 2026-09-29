# ADR-004: Explicit prompt caching of a static prefix

- **Status:** accepted (cost replay pending, Block 2.8)
- **Date:** 2026-09-28

## Context

On GPT-5.6+ models OpenAI bills cache **writes** at 1.25x the input price and reads at 0.1x.
The default (implicit) mode writes the whole prompt up to the latest user message. In RAG the
retrieved chunks change on every question, so that prompt is almost never read back: implicit
caching can make RAG input more expensive than no caching at all.

## Decision

- The prompt starts with a **static, byte-identical developer prefix** (rules, citation format,
  seven few-shot examples; 1,264 tokens) with a single `prompt_cache_breakpoint`, and
  `prompt_cache_options = {mode: explicit, ttl: 30m}`. Documents, history and the question come
  after it and are never written to the cache.
- The few-shot examples must earn their place on quality (eval, W2); caching only makes them cheap.
- `RAG_PROMPT_CACHE_MODE` switches to `implicit` or `explicit_none` for the cost replay.
- Tenant content never enters the cache, so cache timing cannot leak other tenants' documents.

## Consequences

- **Measured** (gpt-6-luna, ~1,590 input tokens, ~25 output tokens): the first question after
  a prefix change writes 1,264 tokens and costs **$0.000206**; later questions read them and cost
  **$0.000056**, a 73% reduction for this prompt shape.
- A prefix change (new prompt version) costs one write; the 30-minute TTL means organic hit rates
  depend on traffic. The replay will report the measured cached/input ratio, not an assumption.
