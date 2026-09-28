# Build log

Planned vs actual time per block of [IMPLEMENTATION_PLAN.md §12](IMPLEMENTATION_PLAN.md#12-schedule),
plus surprises and cuts as they happen. "Actual" is wall-clock time, AI-assisted (Claude Code).

| Block | Planned | Actual | Status | Notes |
|---|---|---|---|---|
| 0.1 Accounts | 1 h | | pending | OpenAI projects with enforced limits, AWS flat-rate eligibility, Langfuse (W2), corpus PDFs |
| 0.2 OpenAI spike | 1 h | | script ready | `make spike` once `OPENAI_API_KEY` is in `.env`; record results below |
| 0.3 Toolchain | 1 h | 0.3 h | done | NestJS 12 kept; see surprises |
| 1.1 Compose, Dockerfiles, health | 2 h | 0.3 h | done | `make creds` done in 1.2 |
| 1.2 CDK dev Storage + Auth, invite | 1.5 h | 0.5 h | done (sign-in verified in 1.4) | see 2026-09-27 |
| 1.3 Drizzle schema, custom SQL, migrate | 2 h | 0.2 h | done | see 2026-09-27 (Block 1.3) |
| 1.4 Auth end to end | 2 h | 0.4 h | done | see 2026-09-28 |

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
