# Runbook: calibrate the relevance gate and test the claims (Block 2.7)

The relevance gate decides whether a question is answered by the LLM or refused without calling it.
Its defaults (`retrieval_gate_tau = 0.30`, `gate_min_lexemes = 2`) are guesses. On the dry run the
gate refused **0 of 7** questions that must be refused, because legal text shares two words with
almost any question.

This runbook sets them from measurements, then tests the pre-registered claims and publishes the
results.

**Prerequisite:** the [golden-set review](golden-review.md) is done and committed. Calibrating
against unreviewed items would tune the gate to possibly wrong answers.

## How the gate works

```python
# services/ai/app/rag/retrieve.py
weak_vector  = max_cos is None or max_cos < RAG_RETRIEVAL_GATE_TAU    # nothing semantically close
weak_keyword = max_matched_lexemes < RAG_GATE_MIN_LEXEMES             # hardly any shared terms
refuse = weak_vector and weak_keyword                                 # both must be weak
```

- **Raising τ** refuses more questions with weak semantic matches.
- **Raising the lexeme minimum** stops shared stop-like legal words ("employer", "act") from
  keeping a question alive.

The trade-off is measured on the golden set:
- **gate refusal accuracy:** how many of the 7 `refuse` items (5 unanswerable + 2 cross-tenant) the
  gate refuses;
- **false gate refusals:** answerable items it wrongly refuses.

**Targets** (`eval/thresholds.yaml`, claim C4): refusal accuracy ≥ 0.80 and false refusals ≤ 5 %.

**False refusals cost more than they save.** A gate refusal saves ≈ $0.0002, but a false refusal
loses a user's answer. When in doubt, choose the setting with fewer false refusals. The model
itself still refuses with the NO_ANSWER sentinel when the passages do not answer the question.

## What runs where

| Step | Command | API calls | Cost |
|---|---|---|---|
| Offline sweeps (gate, k, hybrid) | `make eval-retrieval` with `RAG_*` overrides | none (cached question embeddings) | $0 |
| Live runs (answers, citations, injections) | `make eval` with `RAG_*` overrides | yes | ≈ $0.02 each |

Every setting in `services/ai/app/rag/config.py` can be overridden as `RAG_<NAME>`. Every result
file is stamped with the config hash.

**Tooling still to write** in this block:
- a sweep runner that writes one summary file;
- a paired bootstrap for deltas (`evals/metrics.py`);
- `make eval-report`, which regenerates the README table between `<!-- EVAL:START -->` and
  `<!-- EVAL:END -->` and draws `docs/img/tau.png`.

Until they exist, the steps below do the same by hand.

## Steps

### 1. Baseline

The official run on reviewed items, with the current defaults (see
[golden-review.md](golden-review.md), "After the review"):

```bash
make up
make eval            # writes eval/results/<date>-<sha>.json; commit it
```

### 2. Gate sweep: τ × lexemes (offline)

```bash
mkdir -p eval/results/sweeps
printf "tau\tlexemes\trefusal_acc\tfalse_refusal\tfile\n" > eval/results/sweeps/gate.tsv
for tau in 0.30 0.35 0.40 0.45 0.50 0.55; do
  for lex in 1 2 3 4 5; do
    RAG_RETRIEVAL_GATE_TAU=$tau RAG_GATE_MIN_LEXEMES=$lex make eval-retrieval > /dev/null
    f=$(ls -t eval/results/*.json | grep -v -e replay -e pending | head -1)
    python3 - "$f" "$tau" "$lex" >> eval/results/sweeps/gate.tsv <<'PY'
import json, sys
g = json.load(open(sys.argv[1]))["tier1"]["gate"]
print(sys.argv[2], sys.argv[3], g["refusal_acc"], g["false_refusal"], sys.argv[1], sep="\t")
PY
    mv "$f" eval/results/sweeps/
  done
done
column -t eval/results/sweeps/gate.tsv
```

**Choose** the setting with the lowest false refusal among those with refusal accuracy ≥ 0.80.
Among equals, take the lower τ, which is more permissive. With only 7 refusable items, one item
moves the accuracy by 14 points, so read the Wilson interval stored in each file
(`tier1.gate.refusal_ci95`).

**If no setting meets both targets,** do not force it:
- keep a permissive gate, and let the model's NO_ANSWER refusal do the work;
- report claim C4 as failed, because it is pre-registered;
- a different rule (for example *either* signal weak, not both) is a code change and gets its own
  sweep.

### 3. Apply

- **Defaults:** set `retrieval_gate_tau` and `gate_min_lexemes` in
  `services/ai/app/rag/config.py`. This changes the config hash.
- **Record the chosen point and why:**
  - in [ADR-005](../adr/005-gate-and-answer-cache.md) (calibration section);
  - in the [build log](../BUILD_LOG.md).
- **Commit:** `eval/results/sweeps/gate.tsv` and the chosen run's file. Delete the other per-run
  files.

### 4. Other offline sweeps (claims C1 and C6)

- **k (C6):** every tier-1 file already holds `recall_at_3`, `recall_at_5` and `recall_at_8`, so
  the baseline answers "top-5 loses at most 5 points against top-8".
- **Hybrid on/off (C1):**
  ```bash
  RAG_HYBRID_ENABLED=false make eval-retrieval
  ```
  Compare golden `recall_at_5` per question with the baseline. The claim holds only if the paired
  bootstrap's 95 % interval excludes zero.

### 5. Live runs (tier 2, ≈ $0.02 each)

```bash
make eval                                  # the calibrated defaults
RAG_REASONING_EFFORT=low make eval         # does reasoning buy accuracy? (the replay doubled refusals without it)
RAG_TOP_K=3 make eval                      # a smaller context: cost vs citation precision
```

Compare per run:
- refusal accuracy and false refusals;
- citation precision;
- injection success (x of 12, Wilson interval);
- cost per query and p95 latency.

This answers the replay's open question: were the extra refusals without reasoning right or
wrong?

### 6. Claims

Evaluate C1–C6 from `eval/claims.yaml` exactly once each. Record each as **holds**, **fails** or
**inconclusive**, with the numbers, in the build log and next to the README table. Inconclusive and
failed claims are published like the others.

### 7. CI gates

- **Today:** `make eval-ci` fails only on `cross_tenant_leaks`.
- **After calibration:** add the tier-1 metrics that the reviewed baseline meets to `--fail-on` in
  `.github/workflows/ci.yml`, for example `recall_at_5,gate_refusal_acc`, and drop
  `--include-pending`.
- **`eval/thresholds.yaml` changes only deliberately,** in its own commit with a reason; never to
  make a run pass.

### 8. Publish

- **README:** fill the eval table: Config, Recall@5, MRR, Citation precision, Refusal accuracy,
  Injection (x/12), $/query, p95 ms, n. Use one row per run from steps 1 and 5, every value taken
  from a committed results file.
- **README targets:** update the "Initial targets" section with what was met.
- **INTERVIEW.md and PRD.md:** replace the dry-run numbers with the official ones.

### Optional: answer faithfulness (LLM judge)

Report-only:
1. Label 20 answers by hand (supported or unsupported).
2. Run the judge on the same 20.
3. Publish raw agreement and Cohen's κ next to the judge's score. Without that agreement, the score
   is marked "uncalibrated".
