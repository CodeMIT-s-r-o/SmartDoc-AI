# ADR-008: Cost ledger priced in the database

- **Status:** accepted (ledger); budgets and reservations follow in Block 2.4
- **Date:** 2026-09-27

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

## Consequences

- **Positive:** one formula for every writer, historical costs stay correct after price changes,
  the ledger is tamper-resistant for application code, and budgets read one row per user and day.
- **Negative:** pricing logic lives in PL/pgSQL, so it is tested with database contract tests
  (`services/ai/tests/test_schema_contract.py`) rather than unit tests.
- **Measured:** a warm chat call (3,050 input, 1,024 cached, 300 output tokens) costs
  $0.00036284; a cold one with 1,024 cache-write tokens costs $0.00048060.
