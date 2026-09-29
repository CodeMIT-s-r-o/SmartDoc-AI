# Build log

Planned vs actual time per block of [IMPLEMENTATION_PLAN.md §12](IMPLEMENTATION_PLAN.md#12-schedule),
plus surprises and cuts as they happen. "Actual" is wall-clock time, AI-assisted (Claude Code).

| Block | Planned | Actual | Status | Notes |
|---|---|---|---|---|
| 0.1 Accounts | 1 h | | pending | OpenAI projects with enforced limits, AWS flat-rate eligibility, Langfuse (W2), corpus PDFs |
| 0.2 OpenAI spike | 1 h | 0.1 h | done | see 2026-09-28 (Block 0.2 + 1.6) |
| 0.3 Toolchain | 1 h | 0.3 h | done | NestJS 12 kept; see surprises |
| 1.1 Compose, Dockerfiles, health | 2 h | 0.3 h | done | `make creds` done in 1.2 |
| 1.2 CDK dev Storage + Auth, invite | 1.5 h | 0.5 h | done (sign-in verified in 1.4) | see 2026-09-27 |
| 1.3 Drizzle schema, custom SQL, migrate | 2 h | 0.2 h | done | see 2026-09-27 (Block 1.3) |
| 1.4 Auth end to end | 2 h | 0.4 h | done | see 2026-09-28 |
| 1.5 Upload: presigned POST, /complete, internal URL, documents UI | 1.5 h | 0.6 h | done | see 2026-09-28 (Block 1.5) |
| 1.6 Ingestion worker | 4 h | 1.0 h | done | see 2026-09-28 (Block 0.2 + 1.6) |
| (extra) UI on Material UI + document delete | – | 0.6 h | done | see 2026-09-28 (UI + delete); pulls part of 1.9 forward |
| 1.7 Python chat (retrieval, gate, streaming, breaker) | 3.5 h | 1.0 h | done | see 2026-09-28 (Block 1.7) |
| 1.8 NestJS SSE proxy, conversations, idempotency | 1.5 h | 0.8 h | done | see 2026-09-29 (Block 1.8), ADR-007 |

## 2026-09-26: Block 0.3 + 1.1 (scaffold)

**Result:** `make up` builds and starts db, api, ai, ai-worker and web; all five report healthy.
`/api/health` returns `{"status":"ok","db":"up","ai":"up"}` directly and through the Vite proxy.
`make check` (ESLint, Prettier, tsc, ruff, mypy strict, Vitest, pytest) passes.

**Surprises:**
- **TypeScript 7.0.2 is npm `latest`**, but `@nestjs/cli` 12.0.7 pins `typescript ~6.0.2` and
  typescript-eslint 8.70 supports `<6.1`. TypeScript is pinned to 6.0.3 repo-wide.
- **NestJS 12.1.0 (ESM-only) passed the 20-minute timebox:** `nest build`, a Vitest e2e test
  (decorator metadata via `unplugin-swc`) and a Drizzle `select 1` all worked on the first try.
- **`nest start --watch` in `node:24-slim` restarted into `EADDRINUSE`**: the CLI stops the old
  process with tree-kill, which needs `ps`. Fixed by installing `procps` in the dev stage only.
- **The global `~/.npmrc` points at an employer registry.** The repo pins the public npm registry
  (`.npmrc` + `npmRegistryServer`), so this personal project never depends on it.
- **No Corepack** with asdf's Node 25 and a global Yarn 1.22: Yarn 4.18.1 is vendored via `yarnPath`.
- **A `.python-version` file breaks asdf's `python3` shim** in that directory; uv picks Python 3.13
  from `requires-python` instead.
- **Identity columns need no sequence grants:** the app role inserted into an owner-created table
  with `GENERATED ALWAYS AS IDENTITY`, as the plan assumed. It cannot create or drop tables, and it
  cannot connect to the `postgres` database.

**Measurements (dev, idle, `docker stats`):** api 702 MiB (tsc watch), web 335 MiB (Vite),
ai 77 MiB, ai-worker 40 MiB, db 37 MiB. Dev-only numbers; production runs compiled output with
memory limits (plan §10).

## 2026-09-27: Block 1.2 (dev AWS)

**Result:** `SmartDoc-Dev-Storage` and `SmartDoc-Dev-Auth` are deployed to eu-central-1 after
`cdk bootstrap`. 10 CDK assertion tests guard the security-relevant settings, including "no
localhost anywhere in prod". The dev user is invited to the `admin` group and has not signed in yet.

**Verified:**
- `SmartDocDevApp` (via `make creds`) can put, head and list objects under `users/`, and gets
  AccessDenied for keys outside `users/`, for listing the bucket root, for other buckets and for
  Cognito admin calls.
- AWS credentials reach only the `api` container; `web` gets non-secret config only; `ai` and
  `ai-worker` get nothing.
- Managed login: `/oauth2/authorize` redirects to `/login` (200). A foreign `redirect_uri` is
  rejected with `redirect_mismatch`.

**Surprises:**
- **The Cognito OIDC discovery document now lists `end_session_endpoint`** (`<domain>/logout`).
  The plan assumed it was missing and designed a manual logout redirect; Block 1.4 can try
  `signoutRedirect()` first.
- zsh does not word-split `$VAR` in commands, so `aws ... $PROFILE_FLAGS` fails. Scripts use
  `AWS_PROFILE` instead of flag strings.

## 2026-09-27: Block 1.3 (schema and migrations)

**Result:** 13 tables from one Drizzle schema file plus one hand-written migration (HNSW index,
price EXCLUDE constraint, `updated_at` triggers, ledger triggers, price seed, least-privilege
revokes). A one-shot `migrate` container applies them as the owner role under an advisory lock
before api, ai and ai-worker start. `make test-db` runs 13 schema contract tests as the app role.

**Verified:**
- A fresh volume migrates; `chunks.embedding` is `halfvec(1536)` with an HNSW
  `halfvec_cosine_ops` index (m=16, ef_construction=64), and `tsv` has a GIN index.
- The ledger prices a warm chat call (3,050 input, 1,024 cached, 300 output) at $0.00036284 and a
  cold one (1,024 cache-write tokens) at $0.00048060, matching the plan's $0.000363 and $0.000481.
  Both calls accrue into `user_daily_usage` and `app_daily_usage`.
- An unknown model, or cached tokens above input tokens, is rejected. The app role cannot
  update or delete ledger rows, cannot change prices, and cannot create tables.
- Two concurrent `migrate` runs both succeed and record the migrations once.
- `drizzle-kit generate` reports no drift after the hand-written migration.

**Decisions and deviations from the plan:**
- **Pricing moved into a `BEFORE INSERT` trigger.** Writers insert raw token counts; the trigger
  looks up the price valid at `created_at` and sets `price_id` and `cost_usd`. One formula for
  NestJS, Python and the eval harness.
- **`model_prices` is keyed by (model, service_tier)** with explicit Flex rows, instead of the
  plan's `tier_multiplier` column. The EXCLUDE constraint covers the tier too.
- **The ledger is append-only and prices are migration-only** for the app role (not in the plan).
- **Price check:** OpenAI's pricing page appeared to show gpt-5.6-luna output at $0.75, while the
  model page, which is authoritative, shows $1.20. The seed uses $1.20 and cites the model page.
- Status columns are `text` + `CHECK`, not Postgres enums.

## 2026-09-28: Block 1.4 (authentication)

**Result:** the SPA signs in through Cognito managed login (authorization code + PKCE,
react-oidc-context, tokens in sessionStorage, refresh-token renewal) and signs out by revoking the
refresh token, clearing the session and calling Cognito's `/logout`. NestJS verifies access tokens
in a global guard, creates the `users` row on first sight (email from `/oauth2/userInfo`), serves
`/api/me` and rate-limits per user.

**Verified:**
- 18 API e2e tests with tokens signed by a test key and checked by the real `aws-jwt-verify`
  verifier (production config, JWKS preloaded). **401** for: no header, a non-JWT value, a tampered
  payload, an unknown signing key, an ID token, another app client, another user pool (a dev
  token against prod), an expired token. 401 bodies never say which check failed.
- The email lookup runs once per user; `/api/health` stays public and is never throttled.
- The rate limit is per user: one user hitting the limit gets 429 with `Retry-After`, another
  user is unaffected.
- Live stack: the API prefetches the real JWKS at boot; `/api/me` without a token or with a garbage
  token returns 401 through the Vite proxy; "Sign in" lands on managed login with
  `code_challenge_method=S256`.
- **Live sign-in (the invited user, in person):** temporary password replaced (Cognito status
  `CONFIRMED`), the app shows email, admin role and today's spend, and the first request created
  the `users` row with the email from userInfo.

**Notes:**
- Cognito's discovery now lists `end_session_endpoint` and `revocation_endpoint`. Revocation uses
  oidc-client-ts's standard `revokeTokens()`. Logout still builds Cognito's URL by hand, because
  `/logout` wants `client_id` + `logout_uri` rather than the OIDC `post_logout_redirect_uri`.
- **Deferred:** RFC 9457 problem+json errors (Nest's default JSON error shape for now), an OpenAPI
  document, and the named per-route limits (30 chats/min, 10 uploads/h) until those routes exist.

## 2026-09-28: Block 1.5 (uploads)

**Result:** the browser reserves a document (`POST /api/documents`), uploads straight to S3 with
a presigned POST, and calls `/complete`. That call checks what actually landed (size, content type,
`%PDF-` magic bytes on that exact version), then pins the version and enqueues the ingestion job
in one transaction. The worker gets a version-pinned download URL from
`POST /internal/documents/:id/download-url` (internal token, outside `/api`). The UI lists
documents and polls with a 2 s → 5 s → 10 s backoff while anything is queued or processing.
Every API error is now RFC 9457 `application/problem+json` with a machine `code`.

**Verified live against the dev bucket:**

| Case | Result |
|---|---|
| Real PDF | S3 204, `/complete` 202 `queued`, 1 job, version pinned |
| `.txt` renamed to `.pdf` | S3 accepts, `/complete` **422 INVALID_FILE**, version deleted (0 versions, 0 delete markers) |
| 21 MB file declared as 1 KB | **S3 400 EntityTooLarge** (the policy, not the API, enforces it) |
| 21 MB declared honestly | API **422 FILE_TOO_LARGE**, no policy issued |
| Tampered `Content-Type` field | S3 **403 AccessDenied** |
| Tampered key (another tenant's prefix) | S3 **403 AccessDenied** |
| Internal route | URL pinned to the version, bytes start with `%PDF-1.4`; 401 without the token; 404 for a failed document and through the web proxy |
| Polling | gaps of 2.1 s, 5.0 s, 10.1 s while a document is queued |

**Tests:** 39 API e2e tests (upload, validation, quota, 10 uploads/h, complete, tenant isolation
on every route, the internal route), 2 unit tests that decode the real S3 POST policy and the
presigned GET, 5 repository tests against Postgres (`make test-db`), 2 web tests.

**Bug found and fixed:** the first polling version advanced its backoff on every evaluation of
`refetchInterval` (which TanStack Query runs on renders too), so it would jump straight to 10 s.
The step is now derived from `dataUpdateCount`. (Also by design: no polling in hidden tabs.)

**Deferred:** `DELETE /api/documents/:id` and `/retry` (need the worker's failure codes and the
full delete cascade), the W2 SHA-256 dedup, and a reconciler for abandoned `uploading` rows.

## 2026-09-28: Block 0.2 (OpenAI spike) and Block 1.6 (ingestion worker)

**Spike results** (`make spike`, gpt-6-luna, Responses API, `effort: none`):

| Check | Result |
|---|---|
| Explicit prompt cache, fresh prefix | call 1: `cache_write_tokens=1291`, `cached_tokens=0`; call 2: `cached_tokens=1291`. Only the static prefix up to the breakpoint is written; the question is not |
| Streaming | TTFT 0.8 to 1.7 s; `response.completed` carries full usage; `reasoning_tokens=0` at effort none |
| `temperature` at effort none | accepted |
| Embeddings | text-embedding-3-small, 1,536 dimensions |
| Flex (`service_tier: "flex"`) | works for gpt-6-luna |

The very first spike run already showed `cached_tokens=1264` with no write: the prefix was still
warm from an earlier run, a reminder that the replay must control cache state explicitly.

**Worker result:** polls the Postgres queue every 2 s, claims with `FOR UPDATE SKIP LOCKED`
(attempts counted at claim, lease token as a fencing token, 15-minute lease), downloads the pinned
version through the API, parses in a spawned child with RLIMIT_AS 320 MB / RLIMIT_CPU 60 s / 90 s
wall clock, chunks per section (500 tokens, 75 overlap, cl100k), embeds with a
"title > section" header in batches of 256, writes one ledger row per embeddings call, and
finalizes in one fenced transaction (replace chunks, document `ready`).

**Verified live** (dev stack, real OpenAI and S3):

| Input | Result |
|---|---|
| Synthetic handbook, 102 pages | `ready` in ~6 s: 214 chunks over 50 sections, max 498 tokens, page ranges match, no header/footer text left, 73,416 embedding tokens = **$0.00146832** in one call |
| "Scanned" PDF (no text layer) | `NO_TEXT_LAYER` on attempt 1, no retries |
| Decompression bomb (120 MB of content) | `PARSE_LIMIT_EXCEEDED`, worker unaffected (140 MiB RSS) |
| Re-ingesting the handbook | chunks replaced (not duplicated); a second ledger row kept |
| Expired API credentials | 3 attempts with 60 s / 120 s backoff, then `failed`: the retry path works |

HNSW returns a chunk's own vector first (cos 1.0); FTS finds "2 Annual leave > 2.3 Carry-over".

**Tests:** 29 worker unit tests (parser incl. encryption, page/char limits, bombs, outline and
numbered sections; sandbox limits; chunk offsets and page ranges; batching), passing on macOS and
inside the Linux image (where RLIMIT_AS is enforced too); 10 queue tests against Postgres (SKIP
LOCKED under concurrency, lease reclaim and fencing, retry, fail, fenced finalize, rollback when
the document changes); 3 download tests.

**Bugs found by the tests and fixed:**
- **langchain's `add_start_index` is wrong with a token-based splitter:** it subtracts the overlap
  as characters (75) while the overlap is 75 *tokens* (~300 characters), so `find()` misses and
  offsets drift; page citations would have been wrong. Offsets are now located monotonically.
- **pypdf's `extract_text()` swallows its own decompression-limit error** and returns "", which
  disguised the bomb as NO_TEXT_LAYER. Content streams are decoded explicitly first.
- The header/footer filter removed every line of 3-line pages; edge lines no longer overlap and
  must be short.
- Heading-only sections ("1 Working hours" directly followed by "1.1 ...") produced title-only
  chunks; they are skipped (224 -> 214 chunks on the handbook).

**Security fix:** a failed S3 download logged the full presigned URL (signature and session token)
and stored it in `ingestion_jobs.last_error`. Download errors now carry only the status and S3
error code ("S3 returned 400 ExpiredToken"); the stored rows were redacted.

**Developer experience:** the API now refuses to presign with expired `make creds` credentials
(503 "run make creds") instead of silently producing URLs S3 rejects. DB tests moved to their own
database, `smartdoc_test` (created by `init-roles.sh`, migrated by the `migrate` service), so the
dev worker never claims test jobs.

**Deviations from the plan:** the document title stays the user's filename (a PDF's `/Title`
metadata is often "Microsoft Word - doc1.docx"); chunk-hash embedding reuse is still W2.

## 2026-09-28: UI on Material UI, document delete

**Why now:** the placeholder UI was not presentable, and documents could not be removed.

**UI:** Material UI 9 (Material Design, open source, accessible components), Roboto,
light and dark schemes that follow the OS. App bar with today's spend against the daily limit
and an account menu; sign-in card; documents card with drag and drop, multi-file upload with
per-file progress (XHR, since fetch reports no upload progress), status chips with
plain-language failure reasons (e.g. "No selectable text. Scanned PDFs are not supported yet."),
Open and Delete actions, confirmation dialog, snackbars; a chat panel placeholder so the page
already has its final layout.

**Delete (`DELETE /api/documents/:id`, 204), in every state including uploading and processing:**
1. Compare-and-set to `deleting`: the document leaves scope at once, and a running ingestion's
   finalize (which requires `processing`) rolls back.
2. One transaction: strip this document's snippets from past answers' citations (title and
   pages stay), then delete the row; chunks and jobs cascade. The ledger and retrieval telemetry
   have no FK and survive.
3. Delete every S3 version and delete marker under the document's prefix. If that fails the user
   still gets 204 (the document is gone everywhere it can be read from) and the prefix is logged
   for the reconciler.

The UI removes the row optimistically and restores it if the call fails.

**Tests:** 5 new API e2e tests (queued and uploading deletes, the worker can no longer fetch it,
404 on repeat, S3 failure), a cross-tenant delete added to the isolation test, 2 Postgres tests
(cascade, citation redaction, ledger kept, other tenant cannot mark deleting), 3 component tests
(Testing Library: details and status, failure reason, Delete offered in every state).

**Incident:** at 22:53 something ran `npm i` in the repo root (not a command from this session).
npm created `package-lock.json` and rewrote `yarn.lock` in the Yarn v1 format, breaking Yarn 4.
Restored the lockfile from git and reinstalled. Guard added: `engines.npm` plus
`engine-strict=true` in `.npmrc`, so `npm install` now fails fast with EBADENGINE.

**MUI 9 note:** system props on layout components (`<Stack alignItems="center">`) were removed;
everything goes through `sx`.

**Found during the live review, fixed:**
- **The API crashed when Postgres restarted** (22:59: `57P01 terminating connection due to
  administrator command`). node-postgres emits 'error' on the pool for a dead idle connection,
  and without a listener that kills the process. The pool now logs it and reconnects (unit test).
- **Three of the user's uploads stuck in `uploading`**, with no object in S3: the api container
  still had `make creds` credentials that had expired at 20:43Z (`docker compose restart` does not
  re-read `env_file`), so S3 rejected the POSTs. Such reservations now show as "Interrupted" after
  10 minutes (the presigned POST expires after 5), with the advice to delete and upload again.
- **An orphan reservation when presigning failed:** `create` inserted the row before presigning.
  It now presigns first (regression test).
- `apps/web/public` was not mounted into the dev container, so Vite answered with `index.html`;
  `/complete` correctly rejected that as "not a PDF".

**Verified live (the new UI code, in the signed-in browser):** XHR upload with progress (and its
CORS preflight) 305 ms; `queued -> processing -> ready` (14 pages, 40 chunks, $0.00018); delete:
0 S3 versions and 0 delete markers left, no rows left, the ledger row kept. The user uploaded and
ingested their own document through the UI. Screens checked in light and dark, at 1280 px and on
a 375 px phone.

**Dev credentials now last 12 hours** (was 1): `SmartDocDevApp` `MaxSessionDuration` 43,200 s
(deployed), `duration_seconds = 43200` in the `smartdoc-dev-app` profile, and `make creds`
recreates the api container itself. Every failed upload of the day traced back to an expired
1-hour session. The role still reaches only `users/*` in the dev bucket. (Deviation from plan §3.3.)

**Known gap:** a presigned POST stays valid for 5 minutes, so a client could still upload to the
key of a document it just deleted. The object would be an orphan with no database row (no
ingestion, no access); the W2 reconciler removes such prefixes.

## 2026-09-28: Block 1.7 (Python chat)

**Result:** `POST /internal/chat` (internal token) streams SSE per the contract: `meta`, `sources`,
`token`..., then exactly one `done` or `error`; FastAPI's native SSE pings every 15 s (checked in
its source: `_PING_INTERVAL = 15.0`). Pipeline: embed the question -> in one transaction verify
the document scope (`FOR SHARE`) and run hybrid retrieval (HNSW + OR-tsquery FTS, RRF k=60) ->
gate -> context (top 5, 2,000 tokens, deduplicated) -> prompt v1 (escaped documents, explicit
cache breakpoint on a 1,264-token static prefix) -> streamed answer with the NO_ANSWER sentinel
held back -> citations -> one ledger row per call -> `rag_requests` + `retrievals`.
`POST /internal/retrieve` exposes retrieval alone for the eval harness.

**Verified live** (real OpenAI, a 4-page policies document):

| Question | Result | Prompt cache | Cost | TTFT |
|---|---|---|---|---|
| Leave carry-over | correct, cites [1] p. 1 | write 1,264 | $0.000206 | 3.1 s (cold) |
| EU meal allowance | correct, cites [1] p. 2 | **read 1,264** | **$0.000056** | 1.1 s |
| Approval for EUR 1,200 | correct inference (manager + department head) | read 1,264 | $0.000058 | 2.1 s |
| CEO's favourite colour | **gate: no LLM call** | – | $0.00000016 | 0.17 s |
| OpenAI unreachable (black-hole base URL) | `degraded`: keyword-search passages ("2 Travel", "4 IT security"), $0 | – | $0 | – |
| Client hangs up after 3 tokens | `aborted`; OpenAI stream closed; estimated chat row (usage_estimated) | – | – | – |

The warm-cache cost matches the formula: (326 x 0.10 + 1,264 x 0.01 + 21 x 0.50) / 1e6 + embedding.

**Breaker, measured:** during the outage the first five requests took ~2.2 s each (2 s connect
timeout, no retry on the question embedding), then the breaker opened and answers took 0.26 s.
The first version used the SDK defaults (5 s timeout, one retry) and needed 10-11 s per request.

**Tests:** 21 unit tests (escaping incl. tag breakout and bidi, prefix >= 1,024 tokens,
breakpoint placement per cache mode, history trimming, citations, breaker, context budget,
SSE framing and auth) and 10 pipeline tests against Postgres with a fake OpenAI: answer with
ledger and telemetry, OR-tsquery keyword recall, scope mismatch (other tenant, not ready), gate,
degraded when embeddings or the chat call fail, open breaker, NO_ANSWER sentinel, broken stream,
prompt escaping. **Every emitted event is validated against the JSON Schema generated from the
zod contract** (`packages/contracts/schema/sse-events.schema.json`, kept fresh by a test).

**Findings for W2:**
- **Meta-questions hit the gate:** "Summarize every policy in detail" is not close to any single
  chunk and shares no terms, so it is refused without an LLM call. Calibrate tau on the eval and
  consider routing summary questions differently.
- The estimated usage on abort counts the whole prompt as uncached: conservative for budgets.
- `openai` 3.19 uses `httpx2`; timeouts must be `openai.Timeout`, not `httpx.Timeout`.

## 2026-09-29: Block 1.8 (NestJS SSE proxy)

**Result:** `/api/conversations` CRUD and `POST /api/conversations/:id/messages`, which streams
`ack` + the AI service's events straight through (one read loop, contract-validated collector),
pre-inserts the assistant message as `streaming`, and persists it on done, close or error. The
same `clientMessageId` twice never calls the LLM twice. A 60 s housekeeping tick closes messages
left `streaming` by a crash. Decisions in [ADR-007](adr/007-streaming.md).

**Verified live** (browser session -> NestJS -> Python -> OpenAI, two ready documents):

| Step | Result | Cost | Timing |
|---|---|---|---|
| "How many days of annual leave do I get?" | `ack, meta, sources, token x14, done`; "25 paid annual leave days [3]"; both messages stored, citation 3 flagged `cited` | $0.000381 (cache write 1,264) | first token 4.56 s in the browser vs 4.50 s TTFT in Python (cold) |
| Same `clientMessageId` again | 200 JSON with the stored answer, no new `rag_requests` row | $0 | – |
| Follow-up "And how many of them can I carry over?" | history reached the model, but retrieval ran on the literal follow-up and missed the leave chunk -> `no_answer_model` | $0.000240 (**cache read 1,264**) | TTFT 1.2 s |
| Client aborts after 3 tokens | message `aborted` with the partial text; ledger row `usage_estimated` | $0.000337 (estimate, no cache credit) | – |

**Tests:** 12 new DB tests (real HTTP against a fake AI service, see ADR-007) and 3 collector
unit tests (frames and a UTF-8 character split across chunks, contract violations counted).

**Surprises:**
- **Ordering bug caught by the history test:** both rows of a turn share `created_at` (`now()`
  is the transaction start), and the role tie-break was inverted in both queries, so history
  went to the model as answer-before-question. Fixed; the conversation detail test now checks
  the order too.
- The API image now builds `@smartdoc/contracts` (a workspace package with a `dist/`), and
  `make install` / `yarn typecheck` build it first; Vitest aliases it to the TS source.

**Findings for W2:**
- **The follow-up miss is the case for the standalone rewrite** (plan §7, cut-if-behind): with
  history, retrieval needs "how many annual leave days can I carry over", not "how many of them".
  Add this exact exchange to the 3 follow-up items of `golden_v1`.
- The cold first request spent 2.3 s in retrieval (embedding + connection warm-up); warm requests
  take 0.2-0.4 s.
