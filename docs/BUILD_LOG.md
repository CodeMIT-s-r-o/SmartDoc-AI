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
| 1.9 Chat UI (stream, citations, open PDF p. N, cost badge, thumbs) | 3 h | 1.0 h | done, **MVP gate passed** | see 2026-09-29 (Block 1.9) |
| 2.1 Generated IDOR test, ledger formula tests | 1 h | 0.5 h | done (scope hash moves to 2.5) | see 2026-10-01 (Block 2.1) |
| 2.4 Budgets: reservations, release, sweeper, 429 + banner | 1 h | 0.9 h | done | see 2026-10-05 (Block 2.4), ADR-008 |
| 2.5 Exact cache, scope hash, savings, rewrite, upload dedup | 2 h | 1.5 h | done (rewrite pulled in from cut-if-behind) | see 2026-10-22 (Block 2.5), ADR-005 |
| 2.6 Eval corpus, datasets, harness (tiers 1-2), CI fixture | 2.5 h | 2.5 h | in progress: golden review pending | see 2026-10-23 (Block 2.6) |

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

## 2026-09-29: Block 1.9 (chat UI)

**Result:** the chat panel replaces the placeholder. It streams answers (`fetch` +
`EventSourceParserStream`, every event validated by the shared zod contract, as in NestJS), shows
"Searching your documents…" / "Reading N passages…" before the first token, renders the answer
with react-markdown (no raw HTML, no images, links only to our origin), turns `[1, 3]` into
citation markers (a 40-line remark plugin, no dependency), and lists cited sources first with the
other retrieved passages behind "+N more". A source popover shows section, pages and snippet with
"Open PDF p. N". Each answer has a cost/latency badge (ledger total from `rag_requests`) and
thumbs; a thumbs-down is saved at once, then asks for reasons (a fixed enum in
`packages/contracts`). `no_answer`, `degraded` (closest passages), `aborted` ("Stopped") and
`error` (Retry) each have their own rendering. Previous chats: a history menu (open, delete) and
"New chat"; the open chat is remembered per browser. Backend additions: `POST/DELETE
/api/messages/:id/feedback` (upsert, tenant-joined, answers only) and cost, latency and rating
on each message.

**Verified live** (browser pane, real OpenAI):

| Check | Result |
|---|---|
| History of the Block 1.8 chat | complete answer with marker and "+4 more passages", no_answer with closest passages, aborted with "Stopped"; every badge shows the ledger cost |
| New question (EU meal allowance) | "Searching…" -> "Reading 5 passages…" -> answer with [1]; badge $0.00030 · 4.1 s; the header's daily spend went $0.0010 -> $0.0013 |
| Source popover | "2 Travel · p. 2", snippet, "Open PDF p. 2" |
| Open PDF | presigned GET with `response-content-type=application/pdf`, `inline; filename*=UTF-8''…`, 300 s; the SPA appends `#page=N` |
| Thumbs-down + "Incomplete" | `feedback` row: rating -1, reasons `{incomplete}`, `request_id` = the answer's `rag_request_id` |

**Tests:** 19 new web tests (markdown safety: script/img/javascript:/data:/external links;
citation markers; stream parsing across 7-byte chunks with an invalid event and a ping; replay;
problem+json; live-turn merge with stored messages; statuses; Stop keeps the partial answer;
retry after an unacknowledged send reuses the `clientMessageId`; component states, popover,
thumbs) and 1 DB test (ledger cost/latency on the answer, feedback upsert/change/delete, 404 for
user messages and other tenants, 400 for reasons on a thumbs-up).

**Surprises:**
- **Popover anchored to the top of the page:** an inline `components={{ a: … }}` object gives
  react-markdown a new element type on every render, so opening the popover remounted the
  marker and detached its anchor. Fixed with module-level components and a context for the
  citation renderer.
- The dev AWS credentials (12 h) had expired: "Open PDF" got a 503 `UNAVAILABLE` with a clear
  detail; the UI now says "try again" for that and "no longer available" only for 404.
  `make creds` fixed it.
- The browser pane blocks popups and cross-origin navigation started by automation, so the PDF
  tab itself has to be checked with a real click; the URL parameters were verified instead.

**Findings for W2:**
- **Small documents lose retrieval to a large one:** multi-topic questions ("travel, expense
  approval and IT security rules") retrieved only chunks from the 102-page synthetic handbook, so
  the 4-page policies document never reached the top 5 and the answer was `no_answer`. Candidates:
  a per-document cap or MMR in `assemble`, and golden items that mix both documents.
- **Bundle:** 885 kB / 269 kB gzip (MUI, zod, the unified/remark stack). Split vendor chunks for
  caching and check `zod/mini` for the browser before the prod deploy.

## 2026-10-01: Block 2.1 (tenant isolation and core tests)

**Result:**
- **Generated IDOR test** (`apps/api/test/db/idor.db-spec.ts`). It reads the routes Express
  actually mounts (global prefix included), not a hand-kept list:
  - User B calls every `:id` route with user A's ids and must get 404 `NOT_FOUND`, and A's
    document, conversation, messages and rating must be unchanged afterwards.
  - Every parameterless `GET` (`/me`, lists, health) as B must not contain any of A's ids or
    titles.
  - Internal routes must refuse a user token (401).
  - A route without a fixture, or a fixture for a route that no longer exists, fails the test.
  - The owner first reaches every fixture id (200/204), so a 404 is isolation, not a typo.
- **Ledger formula tests** (`services/ai/tests/db/test_ledger.py`), pinned to calls measured
  live:
  - warm cache (326 + 1,264 cached + 21 out) = $0.00005574;
  - cold cache write = $0.0003812;
  - reasoning tokens are not billed twice;
  - Flex is half price, and embeddings have their own price;
  - an unknown model, or a call before the price's `effective_from`, is refused;
  - spend accrues per Europe/Bratislava day (21:59 vs 22:30 UTC), and `requests` counts chat
    only;
  - the app role cannot update or delete `llm_calls` or change prices.
- Already covered before this block: page mapping (`test_chunk`), the citation parser
  (`test_citations`) and lease CAS with two workers (`test_jobs`). The scope hash belongs to the
  exact cache and moves to 2.5.

**Proof that the IDOR test bites:** with the tenant filter removed from
`ConversationsRepository.findOwned`, it failed on `GET /api/conversations/:id` (200, a leak) and
`POST …/messages` (409, past the ownership check). `PATCH` and `DELETE` still answered 404
because their own queries filter by tenant too (defense in depth). The change was reverted.

**Tests:** 5 new API DB tests (25 in total) and 7 new Python DB tests (40 in total).

**Surprises:** the stack was down after two days, so the first ledger run spent 3.5 minutes
retrying connections before erroring. `make up` brought everything back healthy.

## 2026-10-05: Block 2.4 (budgets)

**Result:**
- **`BudgetService`** (NestJS) reserves before the chat request reaches the AI service. The
  reservation SQL is the one in §7 of the plan, and the decisions are in ADR-008:
  - The estimate is the worst case, $0.00076 for gpt-6-luna, priced from `model_prices` for
    `RAG_CHAT_MODEL`.
  - First the user's limit (default $0.25), then the global cap (`GLOBAL_DAILY_CAP_USD`, $2).
  - Refused → 429 problem+json `BUDGET_EXCEEDED` with `scope`, `resetsAt` and `Retry-After`
    until midnight in Bratislava, sent before any SSE byte and with nothing stored.
- **Release and housekeeping:**
  - Release is idempotent and uses the reservation's stored day.
  - It runs on every exit (done, error, abort, duplicate `clientMessageId`), before the
    response ends.
  - The housekeeping tick now also releases reservations that expired after 5 minutes.
  - New table `budget_reservations` (migration 0002) and `CHECK (reserved_usd >= 0)` on both
    usage tables.
- **Web:** the 429 carries `scope` and `resetsAt` into a warning banner above the composer
  ("New questions work again at 00:00 (in 2 h 14 min)"). It clears on the next accepted question
  (`ack`) or when the time passes.
- **`make budget EMAIL=… USD=…`** sets a user's daily limit for the demo. The values go to psql
  as variables, not into the SQL text.

**Tests (DoD):**

| Check | Result |
|---|---|
| First request of the day | succeeds; creates both usage rows; reservation expires +5 min |
| 10 parallel reservations, limit $0.0027 (room for 3) | exactly 3 accepted, 7 refused |
| Same, against a check-then-act mutation | 10 accepted ($0.0076, 2.8x the limit): the test catches it |
| Reserved 23:59:59, released 00:00:30 (frozen clock) | released on the old day; the next reservation lands on the new day |
| Retry-After at 22:30 CEST | 5,400 s, `resetsAt` = 22:00 UTC |
| Global cap | the third user is refused with `scope: app`, nothing charged |
| Crashed request | released by the sweep after 5 minutes, not at 4 |
| Over the limit through `POST …/messages` | 429 + Retry-After, no AI call, no messages stored |
| Answer streamed | reservation released, `reserved_usd` back to 0 |

There are 8 new API DB tests (33 in total) and 4 new web tests (30 in total).

**Verified live** (browser pane, real OpenAI, `make budget … USD=0.001`):
1. First question: answered, $0.00034.
2. Second question: 429. The answer slot says "Today's AI budget is used up." and the banner says
   "New questions work again at 00:00 (in 13 h 59 min)". In the database: spent $0.000336,
   reserved 0, one reservation (released), none for the refused request (0.000336 + 0.00076 >
   0.001).
3. Limit back to $0.25: the next question went through and the banner disappeared on `ack`.

Two UI fixes came out of it:
- The header showed a $0.001 limit as "$0.00"; small limits are now shown exactly.
- Retry is hidden while the budget is used up, since it would only be refused again.

**Surprises:**
- **Released after the response ended:** the release first ran after `res.end()`, so a client
  asking again right away could still see the held budget. The stream now ends only after the
  message is stored and the budget released.
- **The sweep is global:** it released reservations other tests had left open, so its test now
  sweeps first and then measures.
- **Another small-document miss:** "And are receipts required for the per diem?" retrieved only
  handbook chunks and ended as `no_answer`, although the policies page that answered the previous
  turn says so. This is the same W2 finding as the follow-up and mixed-document cases (rewrite,
  per-document cap).
- **Flaky CDK test:** under the parallel `make check`, the first CDK test (which synthesizes
  every stack) once exceeded the 5-second timeout; alone it takes 2.6 s. Synthesis now runs once
  in `beforeAll` with a 30-second budget.
- **Test cap raised:** the Python DB tests bill real ledger rows into today's
  `app_daily_usage` (about $0.02 a run), so the test app runs with a $1,000 global cap.

## 2026-10-22: Block 2.5 (answer cache, follow-up rewrite, upload dedup)

**Result:** the decisions are in [ADR-005](adr/005-gate-and-answer-cache.md).
- **Exact answer cache** (Python):
  - Key: tenant, scope hash and normalized question. The scope hash covers config, prompt
    version and `document_id:ready_at`.
  - A hit replays the stored answer and sources without any OpenAI call and books a
    `cost_savings` row.
  - Only clean answers to standalone questions are stored, for 7 days, behind a guarded insert.
  - Deleting a document clears the tenant's cache; `bypassCache` skips the cache.
- **Standalone rewrite** of follow-ups, for retrieval and the cache key. Pulled in from the
  "cut if behind" list because the follow-up miss was seen live three times.
- **Upload dedup:**
  - The browser sends a WebCrypto SHA-256. A live copy gives 409 `DUPLICATE_DOCUMENT`, shown as
    information, not as an error; an unfinished upload of the same file is resumed instead of
    duplicated.
  - A unique index settles concurrent uploads.
  - The presigned POST pins the checksum, so S3 verifies the bytes.
- **Migration 0003:** `response_cache`, `cost_savings`, `documents.sha256` (unique per tenant
  among live rows).

**Verified live** (real OpenAI, through `/internal/chat`):

| Request | Result | Cost | Time |
|---|---|---|---|
| "What is the daily meal allowance…" | answered | $0.00031576 | 5.3 s |
| Same question, other case and spacing | **cache hit**, no `llm_calls` row, `cost_savings` $0.00031576 | $0 | 11 ms |
| "And how many of them can I carry over to next year?" | rewritten to "How many of my 25 paid annual leave days can I carry over to the next year?" → "up to 5 unused days… [4]" | $0.00027682 | 3.1 s |
| "And are receipts required for the per diem?" | rewritten → "Receipts are not required for the per diem [1]" | $0.00025874 | 2.9 s |

Both follow-ups had ended as `no_answer` before (1.8 and the 2.4 live check). A rewrite is
cheap (183–184 input tokens, 19–23 output tokens, about $0.00003), but **slow: 1.4–1.6 s**,
about half of a follow-up's time.

**S3 checksum (an unverified assumption in the plan):** a policy pinned to the SHA-256 of file A,
then a POST of different bytes of the same length gives **400 `BadDigest`**. File A itself
gives 204. The probe object was deleted.

**Tests:**
- Python: 8 new DB tests (48 in total) for cache hit, misses after a new upload or a re-ingest,
  what is not cached, rewrite and its fallback, and post claims; 6 new unit tests for key
  normalization, scope hash and rewrite escaping.
- API: 4 new DB tests for dedup (resume, 409, per tenant, failed copy, concurrent sends, bad
  hash) and 3 for the post's budget claims, with cache clearing added to the purge test (40 in
  total); a checksum policy unit test.
- Web: 2 new tests for SHA-256 test vectors and duplicate handling.

**Surprises:**
- **`ready_at` can be NULL on a ready document** (fixtures, rows inserted by hand), and the scope
  hash crashed on it. The WIP commit recorded 3 failing Python DB tests. NULL is now part of the
  scope (`-`), and the types say so.
- **The post-claims follow-up test was `xfail(strict)`** by design ("search runs on the literal
  follow-up"). It now runs on the production config with the rewrite on and passes. The sentence
  in the published post is outdated.
- **Port clashes:** another local project (`randevu`) holds 5432 and 8000. `DB_PORT` already
  existed; the AI service's host port is now `AI_PORT` too. Run with
  `DB_PORT=5433 AI_PORT=8001 make up` while both run.
- **Disk:** the disk filled up (325 MB free) and Docker Desktop stopped; after a cleanup, 12 GB
  were free.
- **A one-off 501** from `GET /api/health` in the parallel `make check` (alone, 3 of 3 passes).
  Recorded as a flake to watch.

## 2026-10-23: Block 2.6 (eval corpus and harness), in progress

**Corpus:** five Slovak acts in English translation (`eval/corpus/`, not committed; manifest
with SHA-256, `make corpus-check`):
- the Labour Code (as effective on 17 April 2025) and the travel allowances act (1 January
  2025), both via ILO NATLEX;
- the data protection, cybersecurity and OSH acts.

§ 5 b) of the Slovak Copyright Act excludes legal texts and their translations from copyright.
The plan's US documents were swapped for Slovak law at the user's request; a Slovak-language
corpus was rejected because Postgres 18 has no Slovak (or Czech) stemmer (checked in the
container) and the embeddings are weaker for Slovak.

**Harness** (`services/ai/evals/`, data in `eval/`):
- **Ingest through the real worker:** `process_job` gained a pluggable document source, so
  the corpus goes through the sandboxed parse, chunking, embedding with ledger rows and the
  fenced finalize, with bytes from disk.
- **Three tenants:**
  - eval-main: the acts;
  - eval-other: a generated "Northwind" handbook for cross-tenant probes;
  - eval-canary: 12 generated injection documents (4 classes × 3: direct, delimiter
    breakout, title and bookmark metadata, link and image exfiltration), so they never
    pollute the golden metrics.
- **Corpus size:** 18 documents, 1,002 chunks, 247k tokens, $0.0054 to embed.
- **Datasets:**
  - golden_v1: 30 generated items (24 single-hop, 6 multi-hop; evidence must be verbatim or
    the item is dropped) and 10 hand-written ones (5 plausible-but-absent, 2 cross-tenant,
    3 follow-ups), with quotes checked against the text;
  - retrieval_synth_v1: 150 items;
  - canaries_v1: 12 items.

  Generation: 202 calls, $0.0195, booked in the eval ledger.
- **`make golden-review`:** a local page with each item next to the cited PDF page. Accept,
  fix or reject is written straight into the dataset, and a fix keeps the generated original.
- **`make eval`:**
  - tier 1: Hit/Recall@3/5/8, MRR, gate refusal, 100 cross-tenant probes;
  - tier 2: live pipeline with the cache bypassed, giving citation precision, refusal and false
    refusal, injection success with a Wilson interval, cost and latency;
  - each result file is stamped (git SHA, config hash, dataset hashes, response model) and
    checked against `eval/thresholds.yaml`.
- **Pre-registration:** `eval/claims.yaml` was written before any official run.
- **`make eval-ci`:** a fresh database, migrations, the committed fixture
  (`eval_corpus.dump`, 6.9 MB, and question embeddings in half precision, 0.9 MB) and tier 1
  with **no API call**, exactly as CI will run it.

**Dry run on unreviewed items** (not results; the official baseline waits for the review):

| Metric | Value | Note |
|---|---|---|
| Golden Hit@5 / MRR | 0.83 / 0.54 | right passage found, often not first |
| Synthetic Hit@5 / MRR | 0.83 / 0.64 | |
| Gate refusals (retrieval level) | **0 of 7** | legal text shares 2+ words with almost any question: calibration in 2.7 |
| Cross-tenant | 100 probes, 0 leaks | |
| Citation precision | 0.82 | |
| Injection success | **0 of 12** (95 % CI up to 24 %) | 11 of 12 canary questions still answered correctly |
| Refusals / false refusals | 6 of 7 / 7 of 33 | the false refusals are mostly multi-hop items and weak generated questions |
| Follow-ups | 3 of 3 answered via the rewrite | |
| Cost, latency | $0.00021 per query, p50 1.5 s, p95 2.7 s | |

**Findings and fixes:**
- **Ligatures and legal sections:** the parser now handles both (commit 5234da9).
- **Nondeterministic retrieval (fixed):** the keyword branch ranked ties in `ts_rank_cd`
  without a tie-breaker, so ranks, and which rows the `LIMIT` kept, depended on the physical
  row order. A database restored from the fixture gave different metrics (golden Hit@5 0.80 vs
  0.83). With `id` as the tie-breaker in both branches, the dev database and a fresh restore
  give identical numbers.
- **Clipped source print:** in the NATLEX print of the travel allowances act, deeply indented
  paragraphs are clipped at the right margin ("colle" for "collective"). Recorded as a known
  defect in the manifest.
- **Status-based refusal is stricter than reality:** for the meal allowance question, the
  model said the documents do not state the rate (correct, no invented amount), but without the
  NO_ANSWER sentinel, so it counts as answered.
- **Memory pressure:** swap is 8.7 of 9.2 GB used, with another project's stack running.
  This explains the sporadic timeouts in the parallel `make check` (health, CDK and documents
  e2e tests pass alone).

## 2026-10-26: CI on GitHub Actions and the deployment plan

**Result:** `.github/workflows/ci.yml` runs on every push to `main` and every pull request, with
the same make targets as a laptop and no secrets.

| Job | What it runs |
|---|---|
| Lint, types, unit tests | `make lint`, `make typecheck`, `make test` |
| Database tests and offline eval | Postgres + pgvector through compose (roles from `init-roles.sh`), migrations from the host, `make test-db`, then `make eval-ci` |
| Secret scan | gitleaks over the full history (`--redact`) |

- **Offline eval:** `make eval-ci` restores the committed fixture and runs tier 1 without any API
  call. The run uploads its results as an artifact.
- **Gates:** `make eval` gained `--fail-on`. CI gates on `cross_tenant_leaks` only: the quality
  thresholds would fail today and become gates after the calibration in 2.7. Until the golden set
  is reviewed, CI includes the unreviewed items and its results say so.
- **gitleaks:** runs from its official image, because gitleaks-action needs a license for
  organization repositories. Git's `safe.directory` is set through environment variables,
  because the container's user does not own the checkout.
- **Migrations:** `eval-ci.sh` now migrates from the host, so CI never has to build the API
  image.

**Deployment plan:** [DEPLOY_PLAN.md](DEPLOY_PLAN.md) orders Blocks 2.2 and 2.3 into four phases
with a check after each, the prerequisites only the account owner can do, and the decisions to
make first. One finding: GitHub's arm64 runners are free only for public repositories, and this
one is private, so Graviton images need QEMU builds, a public repository, or an x86 instance.

**Local ports:** two other local projects publish Postgres on 5432 and 5433. SmartDoc ran with
`DB_PORT=5434 AI_PORT=8001`.

