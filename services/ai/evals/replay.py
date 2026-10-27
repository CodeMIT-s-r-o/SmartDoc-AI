"""Cost replay: the same synthetic traffic through three configurations (README.md, "Results").

    make replay            # about $0.35 of OpenAI calls; writes eval/results/replay-*.json
    make replay-report     # the Cost page's copy of the newest full run (apps/web/src/cost/)

Arms, run one after another on the eval corpus (tenant eval-main):
- naive:     effort medium, implicit prompt caching, k=8 with a large context, no gate, no cache
- sensible:  effort none, no prompt caching, k=5, no gate, no cache
- optimized: the production defaults (explicit cache breakpoint, gate, exact answer cache)

Traffic: every golden and synthetic question once, plus 20 % exact repeats of earlier ones,
in a seeded order. Costs come from the ledger (llm_calls) of each arm's request ids, never from
the stream. Everything here is labeled "synthetic replay traffic" with its date.
"""

import argparse
import asyncio
import json
import logging
import random
import uuid
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from psycopg_pool import AsyncConnectionPool

from app.db import create_pool
from app.rag.breaker import CircuitBreaker
from app.rag.chat import ChatPipeline, ChatRequest
from app.rag.config import RagConfig
from app.rag.prompt import HistoryTurn
from evals.env import MAIN, REPO, RESULTS_DIR, eval_settings
from evals.metrics import percentile
from evals.run import Corpus, git, load

log = logging.getLogger("evals.replay")
SEED = 26
REPEAT_SHARE = 0.20
CONCURRENCY = 4
WEB_SUMMARY = REPO / "apps" / "web" / "src" / "cost" / "replay.json"

ARMS: dict[str, dict[str, Any]] = {
    "naive": {
        "reasoning_effort": "medium",
        "prompt_cache_mode": "implicit",
        "top_k": 8,
        "context_token_budget": 4000,
        "retrieval_gate_tau": -1.0,  # never weak on the vector side: the gate never fires
        "exact_cache_enabled": False,
        "rewrite_enabled": False,
    },
    "sensible": {
        "reasoning_effort": "none",
        "prompt_cache_mode": "explicit_none",
        "retrieval_gate_tau": -1.0,
        "exact_cache_enabled": False,
        "rewrite_enabled": False,
    },
    "optimized": {},
}


def traffic(rng: random.Random) -> list[dict[str, Any]]:
    """Unique questions in a seeded order, with 20 % exact repeats of earlier ones mixed in."""
    golden = load("golden_v1.jsonl")
    synth = load("retrieval_synth_v1.jsonl")
    unique = [{"question": g["question"], "history": g.get("history", [])} for g in golden]
    unique += [{"question": s["question"], "history": []} for s in synth]
    rng.shuffle(unique)
    repeats = round(len(unique) * REPEAT_SHARE / (1 - REPEAT_SHARE))
    sequence = list(unique)
    for _ in range(repeats):
        position = rng.randrange(1, len(sequence) + 1)
        sequence.insert(position, dict(rng.choice(sequence[:position]), repeat=True))
    return sequence


async def run_arm(
    pool: AsyncConnectionPool, corpus: Corpus, client: Any, name: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    config = RagConfig(**ARMS[name])
    pipeline = ChatPipeline(pool, client, CircuitBreaker(5, 60, 30), config)
    if config.exact_cache_enabled:  # start cold, so the hits come from this run's repeats only
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM response_cache WHERE tenant_id = %s", (MAIN,))
    gate = asyncio.Semaphore(CONCURRENCY)
    results: list[dict[str, Any]] = []

    async def one(item: dict[str, Any]) -> None:
        async with gate:
            req = ChatRequest(
                uuid.uuid4(),
                MAIN,
                None,
                item["question"],
                [HistoryTurn(h["role"], h["content"]) for h in item["history"]],
                corpus.of[MAIN],
            )
            done = None
            async for event in pipeline.run(req):
                if event.name == "done":
                    done = event.payload()
            results.append({"request_id": str(req.request_id), "done": done})

    # In order, a few at a time: a repeat must arrive after the first answer was stored.
    for start in range(0, len(items), CONCURRENCY):
        await asyncio.gather(*(one(i) for i in items[start : start + CONCURRENCY]))
    return await summarize(pool, name, config, results)


async def summarize(
    pool: AsyncConnectionPool, name: str, config: RagConfig, results: list[dict[str, Any]]
) -> dict[str, Any]:
    ids = [r["request_id"] for r in results]
    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT purpose, count(*), sum(input_tokens), sum(cached_tokens),
                      sum(cache_write_tokens), sum(output_tokens), sum(reasoning_tokens),
                      sum(cost_usd)
                 FROM llm_calls WHERE request_id = ANY(%s::uuid[]) GROUP BY purpose""",
            (ids,),
        )
        by_purpose = {
            row[0]: {
                "calls": row[1],
                "input": int(row[2]),
                "cached": int(row[3]),
                "cache_write": int(row[4]),
                "output": int(row[5]),
                "reasoning": int(row[6]),
                "cost_usd": float(row[7]),
            }
            for row in await cur.fetchall()
        }
        cur = await conn.execute(
            "SELECT id, cost_usd, status FROM rag_requests WHERE id = ANY(%s::uuid[])", (ids,)
        )
        per_request = {str(r[0]): (float(r[1] or 0), r[2]) for r in await cur.fetchall()}
        cur = await conn.execute(
            """SELECT mechanism, count(*), sum(saved_usd) FROM cost_savings
                WHERE request_id = ANY(%s::uuid[]) GROUP BY mechanism""",
            (ids,),
        )
        savings = {r[0]: {"count": r[1], "saved_usd": float(r[2])} for r in await cur.fetchall()}
    costs = [per_request[i][0] for i in ids if i in per_request]
    statuses = Counter(per_request[i][1] for i in ids if i in per_request)
    chat = by_purpose.get("chat", {})
    latency = [r["done"]["latencyMs"]["total"] for r in results if r["done"]]
    total = sum(p["cost_usd"] for p in by_purpose.values())
    return {
        "arm": name,
        "config": ARMS[name],
        "config_hash": config.config_hash(),
        "requests": len(ids),
        "cost_usd": round(total, 6),
        "cost_per_query_usd": round(total / max(len(ids), 1), 8),
        "cost_per_1k_queries_usd": round(1000 * total / max(len(ids), 1), 4),
        "cost_p50_usd": percentile(costs, 50),
        "by_purpose": by_purpose,
        "prompt_cache_token_share": round(chat.get("cached", 0) / max(chat.get("input", 1), 1), 4),
        "statuses": dict(statuses),
        "savings_booked": savings,
        "latency_ms_p50": percentile(latency, 50),
        "latency_ms_p95": percentile(latency, 95),
    }


def attribution(optimized: dict[str, Any], prices: dict[str, Decimal]) -> dict[str, float]:
    """Where the optimized arm saves against its own uncached, ungated, uncached-answer self:
    exact cache (booked baselines), prompt cache (cached tokens at the input price minus the
    write premium), gate (refusals at the median cost of a model refusal)."""
    chat = optimized["by_purpose"].get("chat", {})
    p_in, p_cached, p_write = prices["input"], prices["cached"], prices["write"]
    prompt_cache = (
        Decimal(chat.get("cached", 0)) * (p_in - p_cached)
        - Decimal(chat.get("cache_write", 0)) * (p_write - p_in)
    ) / Decimal(1_000_000)
    return {
        "exact_cache_usd": round(
            optimized["savings_booked"].get("exact_cache", {}).get("saved_usd", 0.0), 6
        ),
        "prompt_cache_usd": round(float(prompt_cache), 6),
        "gate_refusals": optimized["statuses"].get("no_answer_gate", 0),
    }


def web_summary(result: dict[str, Any]) -> dict[str, Any]:
    """What the Cost page shows: per-arm numbers and a waterfall from naive to optimized, all in
    USD per 1,000 queries. The last step is whatever the named mechanisms do not explain (gate
    refusals, rewrite calls, run-to-run noise), so the steps always add up."""
    arms = {a["arm"]: a for a in result["arms"]}
    naive, sensible, optimized = (arms[n]["cost_per_1k_queries_usd"] for n in ARMS)
    per_1k = 1000 / result["requests_per_arm"]
    saved = result["optimized_attribution"]
    exact = -saved["exact_cache_usd"] * per_1k
    prompt = -saved["prompt_cache_usd"] * per_1k
    steps = [
        ("Naive", "total", naive),
        ("No reasoning, k = 5", "step", sensible - naive),
        ("Exact answer cache", "step", exact),
        ("Prompt cache", "step", prompt),
        ("Gate, rewrite, rest", "step", optimized - sensible - exact - prompt),
        ("Optimized", "total", optimized),
    ]
    return {
        "label": result["label"],
        "date": result["date"],
        "gitSha": result["git_sha"],
        "requestsPerArm": result["requests_per_arm"],
        "repeats": result["repeats"],
        "arms": [
            {
                "arm": a["arm"],
                "costPer1kUsd": a["cost_per_1k_queries_usd"],
                "costP50Usd": a["cost_p50_usd"],
                "promptCacheShare": a["prompt_cache_token_share"],
                "latencyP50Ms": a["latency_ms_p50"],
                "latencyP95Ms": a["latency_ms_p95"],
                "statuses": a["statuses"],
            }
            for a in result["arms"]
        ],
        "waterfall": [
            {"label": label, "kind": kind, "usdPer1k": round(value, 4)}
            for label, kind, value in steps
        ],
        "gateRefusals": saved["gate_refusals"],
    }


def write_web_summary(result: dict[str, Any]) -> None:
    WEB_SUMMARY.write_text(json.dumps(web_summary(result), indent=2) + "\n")


async def chat_prices(pool: AsyncConnectionPool, model: str) -> dict[str, Decimal]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT input_usd_per_mtok, cached_input_usd_per_mtok, cache_write_usd_per_mtok
                 FROM model_prices WHERE model = %s AND service_tier = 'default'
                  AND tstzrange(effective_from, effective_to) @> now()""",
            (model,),
        )
        row = await cur.fetchone()
    assert row is not None, f"no price for {model}"
    return {"input": row[0], "cached": row[1], "write": row[2]}


async def run(args: argparse.Namespace) -> None:
    from openai import AsyncOpenAI

    settings = eval_settings()
    if settings.openai_api_key is None:
        raise SystemExit("OPENAI_API_KEY is required (set it in .env)")
    items = traffic(random.Random(SEED))
    if args.limit:
        items = items[: args.limit]
    pool = create_pool(settings, max_size=CONCURRENCY + 2)
    await pool.open(wait=True)
    arms: list[dict[str, Any]] = []
    try:
        corpus = await Corpus.load(pool)
        async with AsyncOpenAI(
            api_key=settings.openai_api_key.get_secret_value(), max_retries=2
        ) as client:
            for name in args.arms:
                log.info("arm %s: %d requests", name, len(items))
                arms.append(await run_arm(pool, corpus, client, name, items))
                log.info(
                    "arm %s: $%.6f, $%.4f per 1k queries",
                    name,
                    arms[-1]["cost_usd"],
                    arms[-1]["cost_per_1k_queries_usd"],
                )
        prices = await chat_prices(pool, RagConfig().chat_model)
    finally:
        await pool.close()

    result: dict[str, Any] = {
        "label": f"synthetic replay traffic ({datetime.now(UTC).date()})",
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": git("rev-parse", "--short", "HEAD"),
        "requests_per_arm": len(items),
        "repeats": sum(1 for i in items if i.get("repeat")),
        "arms": arms,
    }
    optimized = next((a for a in arms if a["arm"] == "optimized"), None)
    if optimized:
        result["optimized_attribution"] = attribution(optimized, prices)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    suffix = "-pilot" if args.limit else ""
    path = (
        RESULTS_DIR
        / f"replay-{result['date'][:19].replace(':', '')}-{result['git_sha']}{suffix}.json"
    )
    path.write_text(json.dumps(result, indent=2) + "\n")
    if not args.limit and len(arms) == len(ARMS):
        write_web_summary(result)
    summary = [
        {
            k: a[k]
            for k in (
                "arm",
                "requests",
                "cost_usd",
                "cost_per_1k_queries_usd",
                "prompt_cache_token_share",
                "statuses",
            )
        }
        for a in arms
    ]
    print(
        json.dumps(
            {
                "arms": summary,
                "attribution": result.get("optimized_attribution"),
                "file": str(path.relative_to(RESULTS_DIR.parent.parent)),
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arms", nargs="+", default=list(ARMS), choices=list(ARMS))
    parser.add_argument("--limit", type=int, default=0, help="first N requests only (pilot)")
    parser.add_argument(
        "--report", metavar="RESULT", help="only write the Cost page summary of a results file"
    )
    args = parser.parse_args()
    if args.report:
        write_web_summary(json.loads(Path(args.report).read_text()))
        print(f"wrote {WEB_SUMMARY.relative_to(REPO)}")
        return
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for noisy in ("httpx", "httpx2", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
