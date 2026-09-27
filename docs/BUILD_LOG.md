# Build log

Planned vs actual time per block of [IMPLEMENTATION_PLAN.md §12](IMPLEMENTATION_PLAN.md#12-schedule),
plus surprises and cuts as they happen. "Actual" is wall-clock time, AI-assisted (Claude Code).

| Block | Planned | Actual | Status | Notes |
|---|---|---|---|---|
| 0.1 Accounts | 1 h | | pending | OpenAI projects with enforced limits, AWS flat-rate eligibility, Langfuse (W2), corpus PDFs |
| 0.2 OpenAI spike | 1 h | | script ready | `make spike` once `OPENAI_API_KEY` is in `.env`; record results below |
| 0.3 Toolchain | 1 h | 0.3 h | done | NestJS 12 kept; see surprises |
| 1.1 Compose, Dockerfiles, health | 2 h | 0.3 h | done | `make creds` moves to 1.2 (needs the `SmartDocDevApp` role) |

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
