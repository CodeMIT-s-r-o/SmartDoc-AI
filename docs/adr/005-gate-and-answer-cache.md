# ADR-005: Retrieval gate and exact answer cache

- **Status:** accepted (gate thresholds to be calibrated on the eval in Block 2.7)
- **Date:** 2026-10-22

## Context

Two kinds of questions waste money: questions the documents cannot answer, and questions that
were already answered. A third problem showed up live: follow-ups ("and how many of them can I
carry over?") were searched as typed, retrieved the wrong passages and ended as "not found",
which also made them impossible to cache, because their meaning depends on the conversation.

## Decision

- **Retrieval gate.** If the best vector match is below τ = 0.30 cosine *and* fewer than 2 query
  lexemes match, the question is refused without calling the LLM (only the question embedding
  is paid). Both signals must be weak, so a keyword-only hit still reaches the model.
- **Standalone rewrite.** A question with history is first rewritten by the chat model into a
  standalone question (reasoning `none`, at most 120 output tokens, 5-second timeout, no retry).
  The rewrite drives retrieval and the cache key; the model still answers the original question
  with the conversation as history. On any failure the original question is used.
- **Exact cache, tenant-scoped.** Key: `(tenant_id, scope_hash, question_norm_hash)`.
  - `scope_hash = sha256(config_hash | prompt_version | sorted(document_id:ready_at))`: another
    model, retrieval setting or prompt, a new document in scope, or a re-ingest (which moves
    `ready_at`) is a miss by construction. Nothing is ever invalidated by hand.
  - The question is normalized (Unicode NFKC, case-folded, whitespace collapsed, trailing
    punctuation dropped) and hashed.
  - Only standalone questions are cached (first turn, or a rewritten follow-up), only `answered`
    results with valid citations and real (not estimated) usage. Entries expire after 7 days.
  - The insert is guarded: it only happens while every document in the scope is still the
    tenant's and `ready`. Deleting a document also deletes the tenant's cache entries, because
    they may quote its snippets.
  - A hit replays the stored answer and sources (no embedding, no retrieval, no generation) and
    books a `cost_savings` row with the original answer's cost as the baseline. `bypassCache`
    asks for a fresh answer.
- **Semantic cache: deferred.** Matching paraphrases by embedding similarity can return the
  answer to a different question. It needs a false-hit eval (paraphrase pairs plus near-miss
  pairs, measuring wrong answers served) before it can be trusted; that eval was cut.

## Consequences

- **Measured** (dev stack, real OpenAI, 2026-10-22):

  | Request | Result | Cost | Time |
  |---|---|---|---|
  | "What is the daily meal allowance…" | answered | $0.00031576 | 5.3 s |
  | Same, other case and spacing | cache hit | $0 (saved $0.00031576) | 11 ms |
  | "And how many of them can I carry over to next year?" | rewritten, answered (5 days) | $0.00027682 (rewrite $0.0000299) | 3.1 s |
  | "And are receipts required for the per diem?" | rewritten, answered | $0.00025874 (rewrite $0.0000278) | 2.9 s |

  Both follow-ups ended as "not found" before the rewrite (BUILD_LOG 2026-09-29, 2026-10-05).
- **Positive:** the cache can never serve a stale answer after a document change, and it never
  crosses tenants. Every saving is booked per request, so the Cost page reads it from one table.
- **Negative:** a follow-up costs one extra call before retrieval: ≈ $0.00003 (≈ 185 tokens in,
  20 out), but 1.4–1.6 s, about half of the follow-up's total time. Candidates if that matters:
  a smaller model for the rewrite, or skipping it when the question has no references.
  Exact matching misses paraphrases; the hit rate depends on how repetitive the questions are,
  which the cost replay measures (savings curve over the repeat ratio).
- **Pending:** τ and the lexeme threshold are first guesses until the offline sweeps in 2.7
  (refusal accuracy vs false-refusal rate on the golden set). On the dry run, the gate refused
  0 of 7. The procedure is in [runbooks/calibration.md](../runbooks/calibration.md), and its
  result is recorded here.
