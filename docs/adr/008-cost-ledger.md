# ADR-008: Cost ledger priced in the database, budgets with reservations

- **Status:** accepted
- **Date:** 2026-09-27 (ledger), 2026-10-05 (budgets)

## Context

Two services call OpenAI (Python for chat, embeddings and eval; NestJS only enforces budgets).
Every cost claim in the README and every budget decision must trace back to individual billed
calls, priced with the rates valid at the time of the call. GPT-5.6+ bills cache writes at 1.25x
input, so a formula scattered across services would drift.

## Decision

- **One `llm_calls` row per billed API call**, written in its own transaction right after the call
  returns, so a later failure in the request cannot lose the money record.
- **Writers insert raw token counts only.** A `BEFORE INSERT` trigger finds the `model_prices` row
  valid at `created_at` for (model, service_tier), sets `price_id` and computes `cost_usd`:
  `(ordinary·p_in + cached·p_cached + cache_write·p_write + output·p_out) / 1e6`, where
  `ordinary = input − cached − cache_write`. An unknown model fails the insert.
- **An `AFTER INSERT` trigger accrues spend** into `user_daily_usage` and `app_daily_usage`
  (Europe/Bratislava days), in the same lock order the budget reservation will use.
- **Prices are versioned, never updated:** a price change closes the current row
  (`effective_to`) and inserts a new one; an EXCLUDE constraint rejects overlaps.
- **Least privilege:** the app role can only INSERT and SELECT ledger rows and only SELECT prices.
- **Budgets hold a reservation, not a guess.** Before a chat request reaches the AI service,
  NestJS reserves its worst-case cost (4,600 input + 600 output tokens at the chat model's full
  rate, $0.00076 for gpt-6-luna) in one READ COMMITTED transaction: ensure today's usage rows
  exist, then `UPDATE … SET reserved_usd = reserved_usd + $e WHERE spent + reserved + $e <=
  limit` on the user row and then on the app row (global cap $2), then insert the reservation.
  Zero rows updated means 429 `BUDGET_EXCEEDED` with `Retry-After` until midnight in Bratislava,
  and the whole transaction rolls back.
- **Release is idempotent and day-pinned.** The reservation row stores its `day`, so a request
  that started at 23:59 releases yesterday's budget. It is released before the response ends;
  a 60-second housekeeping tick releases reservations older than 5 minutes (crashed requests).
  `CHECK (reserved_usd >= 0)` makes a double release fail loudly.

## Consequences

- **Positive:** one formula for every writer, historical costs stay correct after price changes,
  the ledger is tamper-resistant for application code, and budgets read one row per user and day.
- **Negative:** pricing logic lives in PL/pgSQL, so it is tested against a real database
  (`services/ai/tests/db/test_ledger.py`, `apps/api/test/db/budget.db-spec.ts`) rather than with
  unit tests. Between the AI service writing its ledger row and NestJS releasing the
  reservation, the cost is briefly counted twice: conservative by design. An abort releases at
  once, while the AI service may still be booking its estimated row, so a parallel request can
  overshoot by at most one answer.
- **Measured:** a warm chat call (3,050 input, 1,024 cached, 300 output tokens) costs
  $0.00036284; a cold one with 1,024 cache-write tokens costs $0.00048060.
- **Measured (budgets):** 10 parallel reservations against a $0.0027 limit (room for 3 answers
  at $0.00076) accepted exactly 3 and refused 7. The same test against a naive check-then-act
  version (SELECT, then an unconditional UPDATE) accepted all 10: $0.0076, 2.8x the limit. The ledger
  formula is pinned to live calls: warm cache $0.00005574, cold cache write $0.0003812.
