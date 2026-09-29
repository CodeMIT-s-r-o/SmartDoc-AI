# ADR-007: Chat streaming through NestJS

- **Status:** accepted
- **Date:** 2026-09-29

## Context

Answers stream from the Python AI service (OpenAI Responses API, token by token). The browser
talks only to NestJS, which owns auth, tenancy, conversations and messages. A send must survive
double clicks and network retries without paying twice, a closed tab must stop the OpenAI call,
and a crashed process must not leave messages stuck "typing" forever.

## Decision

- **SSE over `POST /api/conversations/:id/messages`**, not WebSockets and not `EventSource`
  (GET-only, no auth header). The browser reads the body with `fetch` and a stream parser. Same
  framing end to end: `event: <name>\ndata: <json>\n\n`, validated by one zod contract
  (`packages/contracts`), from which the JSON Schema the Python tests check against is generated.
- **Everything that can be refused is checked before the first byte**: ownership, idempotency,
  document scope. So errors are ordinary RFC 9457 responses (404, 409 `IN_PROGRESS`,
  409 `NO_DOCUMENTS`). After the first byte, failures are one SSE `error` event.
- **Idempotency key:** the client generates `clientMessageId`. One transaction inserts the user
  message (unique `(conversation_id, client_message_id)`) and a **pre-inserted assistant message
  in `streaming` state**. A repeat returns the stored turn as JSON (200) without calling the AI
  service; a repeat while the first is still streaming gets 409 `IN_PROGRESS`; a concurrent
  duplicate that loses the insert race is served as a repeat.
- **One read loop, pass-through:** every upstream chunk is written to the browser unchanged and
  fed to a collector (eventsource-parser + the zod contract) that keeps text, sources and the
  terminal event. No re-serialisation and no second consumer, so the proxy cannot reorder or
  drop events. NestJS adds only `ack` first (message ids for the UI).
- **Persist on every exit:** `done` → status from the contract (`complete`, `no_answer`,
  `cached`, `degraded`); client closed → `aborted` with the partial text; upstream error, cut or
  timeout (120 s) → `error`, and the browser gets `UPSTREAM_TIMEOUT` if no terminal event
  arrived. The update only applies `WHERE status = 'streaming'`.
- **Abort propagates:** `res.on('close')` aborts the upstream `fetch`; the AI service sees the
  disconnect, closes the OpenAI stream and books an estimated ledger row.
- **Housekeeping:** a 60 s tick marks `streaming` messages older than 2 minutes as `error`
  (process crash or deploy mid-answer).

## Consequences

- **Measured** (dev stack, real OpenAI): first token in the browser 4,563 ms vs the AI service's
  own TTFT of 4,499 ms on a cold cache: the proxy hop (auth, 4 queries, the turn transaction)
  costs **~60 ms**. A repeated `clientMessageId` returned 200 JSON with **no second
  `rag_requests` row**. Aborting after 3 tokens stored `aborted` with 45 characters, and the
  ledger booked the call as `usage_estimated`.
- **Tests:** 12 tests against Postgres and a fake AI service over real HTTP: event order and
  persistence, history, replay without an LLM call, 409 while streaming, client abort closing
  the upstream, error event / cut stream / HTTP 500, no ready documents, tenant isolation, CRUD,
  housekeeping.
- **Negative:** the proxy ignores `write()` backpressure (answers are a few KB, so the buffer
  stays small); the pass-through forwards an invalid event before the collector rejects it
  (logged; CI's contract test is the real guard). Both rows of a turn share `created_at`, so
  ordering relies on a role tie-break.
- **Reversal condition:** if the UI needs to resume a stream after a reconnect, switch to a
  `Last-Event-ID` replay from stored tokens, or poll the finished message by its id.
