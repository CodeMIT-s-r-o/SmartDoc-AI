# ADR-010: Eval strategy: a deterministic CI tier, a live tier, pre-registered claims

- **Status:** accepted; the official baseline waits for the golden-set review
- **Date:** 2026-10-23 (built), 2026-10-27 (written up)

## Context

The README makes two claims, cost and quality, and both must be measured, not asserted. Quality
has to be checked on every change without paying for API calls or depending on a model that
changes behind an undated alias. The corpus must be public and redistributable, and the questions
must be answerable from it in ways a reviewer can check against the source page.

## Decision

- **Corpus:**
  - five Slovak acts in English translation (Labour Code, travel allowances, data protection,
    cybersecurity, OSH), outside copyright under § 5 b) of the Slovak Copyright Act;
  - the PDFs are not committed: a manifest with SHA-256 hashes and `make corpus-check`;
  - English, because Postgres has no Slovak stemmer and the embeddings are weaker for Slovak.
- **Ingested through the real worker:** `process_job` with a file source, so the sandboxed
  parser, the chunker, the embeddings and the fenced finalize are the ones production uses.
- **Three tenants:**
  - eval-main: the acts;
  - eval-other: a generated handbook for cross-tenant probes;
  - eval-canary: 12 injection documents, kept apart so they never pollute the golden metrics.
- **Datasets:**
  - `golden_v1` (40): 30 generated with verbatim evidence, 10 hand-written (absent answers,
    cross-tenant, follow-ups);
  - `retrieval_synth_v1` (150);
  - `canaries_v1` (12: 4 classes × 3).
- **A human gate on the golden set:** `make golden-review` shows each item next to the cited PDF
  page. Items stay `pending` until accepted or fixed, and pending items are excluded from official
  numbers unless `--include-pending` is passed.
- **Two tiers:**
  - **Tier 1 (retrieval, deterministic, no API calls):** Hit/Recall@k, MRR, gate refusal and
    100 cross-tenant probes.
    - CI restores a committed fixture (a `pg_dump` of the corpus, 6.9 MB) and cached question
      embeddings (half precision, 0.9 MB), then runs `make eval-ci`.
    - Ties are broken by id, so a restored database and the dev database give identical numbers.
  - **Tier 2 (live pipeline, `make eval`):** citation precision, refusal and false refusal,
    injection success with a Wilson interval, cost and latency. The answer cache is bypassed.
- **Gates and stamps:**
  - `eval/thresholds.yaml` holds the targets, changed only deliberately;
  - `--fail-on` turns chosen metrics into CI failures. Today it is `cross_tenant_leaks` only,
    until the calibration;
  - every result file carries the git SHA, the config hash, the dataset hashes and the response
    model.
- **Pre-registered claims:** `eval/claims.yaml` (C1–C6) was written before the first official
  run. Each claim is tested once and reported even when it fails. Deltas use a paired bootstrap
  over question ids, and a delta "holds" only if its 95 % interval excludes zero.
- **Cost is measured separately**, by the three-arm replay on the same corpus (Block 2.8), from
  ledger rows.

## Evidence (dry run on unreviewed items, 2026-10-23; not official numbers)

| Metric | Value |
|---|---|
| Golden Hit@5 / MRR | 0.83 / 0.54 |
| Cross-tenant | 100 probes, 0 leaks |
| Citation precision | 0.82 |
| Injection success | 0 of 12 (95 % CI up to 24 %) |
| Gate refusals (retrieval level) | 0 of 7: the gate needs calibration |
| Cost | $0.00021 per query |

- **The dry run found a real bug:** ranks depended on physical row order (ties in `ts_rank_cd`).
  A restored database scored Hit@5 0.80 against 0.83 on the dev database until the tie-breaker
  was added.

## Consequences

- **Positive:**
  - every pull request checks retrieval quality and tenant isolation for $0;
  - the numbers are reproducible from a fixture;
  - claims cannot be tuned after the fact.
- **Negative:**
  - **Small samples.** 40 golden items and 12 canaries give wide intervals, so 0 of 12
    injections still allows up to 24 %. The intervals are reported, not hidden.
  - **Refusal is judged from the response status.** An answer that correctly says "not in the
    documents" without the NO_ANSWER sentinel counts as answered.
  - **No LLM judge yet.** Faithfulness is planned for 2.7 as report-only, checked against
    20 human labels.
- **Open:**
  - the golden-set review;
  - the 2.7 calibration (gate τ and lexemes), sweeps and the README table.
