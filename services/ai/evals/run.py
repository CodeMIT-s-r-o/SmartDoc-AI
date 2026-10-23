"""Run the eval and write a stamped results file (docs/IMPLEMENTATION_PLAN.md §8).

    make eval            # tier 1 (retrieval, no LLM) + tier 2 (live LLM, about $0.02)
    make eval-retrieval  # tier 1 only; with --offline it never calls OpenAI (CI)

Golden items count only once a person has accepted (or fixed) them in make golden-review;
--include-pending runs all 40 for development, and the results say so.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import subprocess
import uuid
from collections import Counter
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import yaml
from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.db import create_pool
from app.rag.breaker import CircuitBreaker
from app.rag.chat import ChatPipeline, ChatRequest
from app.rag.config import RagConfig
from app.rag.prompt import PROMPT_VERSION, HistoryTurn
from app.rag.retrieve import ScopeMismatch, gate_fires, retrieve, verify_scope
from evals.embeddings import QueryEmbeddings
from evals.env import CANARY, DATASETS_DIR, EVAL_DIR, MAIN, OTHER, RESULTS_DIR, eval_settings
from evals.metrics import Span, hit_at, mean, percentile, recall_at, reciprocal_rank, wilson
from evals.pdfs import northwind_probes

log = logging.getLogger("evals.run")
TOP = 20
KS = (3, 5, 8)
REFUSED = {"no_answer_gate", "no_answer_model"}
CONCURRENCY = 4


def load(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (DATASETS_DIR / name).read_text().splitlines() if line]


def sha(name: str) -> str:
    return hashlib.sha256((DATASETS_DIR / name).read_bytes()).hexdigest()[:12]


def gold_spans(item: dict[str, Any]) -> list[Span]:
    evidence = item.get("evidence") or ([item["gold"]] if "gold" in item else [])
    return [Span(e["document"], e["pages"][0], e["pages"][1]) for e in evidence]


def probes() -> list[str]:
    """~100 cross-tenant probes: every Northwind sentence verbatim, without the company name,
    as its first words only, and as a question. Asked as eval-main, none may find its chunk."""
    out: list[str] = []
    for sentence in northwind_probes():
        bare = sentence.replace("Northwind ", "").replace(" Northwind", "")
        out += [sentence, bare, " ".join(sentence.split()[:6]), f"What does the policy say: {bare}"]
    return out


class Corpus:
    """Ready documents per tenant, and file name / tenant per document id."""

    def __init__(self, rows: list[tuple[UUID, str, UUID]]) -> None:
        self.file = {doc: file for doc, file, _ in rows}
        self.owner = {doc: tenant for doc, _, tenant in rows}
        self.of: dict[UUID, list[UUID]] = {}
        for doc, _, tenant in rows:
            self.of.setdefault(tenant, []).append(doc)

    @classmethod
    async def load(cls, pool: AsyncConnectionPool) -> "Corpus":
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT id, original_filename, tenant_id FROM documents WHERE status = 'ready'"
            )
            return cls([(r[0], r[1], r[2]) for r in await cur.fetchall()])


async def ranked(
    pool: AsyncConnectionPool,
    corpus: Corpus,
    config: RagConfig,
    tenant: UUID,
    question: str,
    vector: list[float],
) -> tuple[list[Span], list[UUID], bool]:
    async with pool.connection() as conn, conn.transaction():
        result = await retrieve(
            conn,
            tenant=tenant,
            document_ids=corpus.of[tenant],
            question=question,
            query_vector=vector,
            config=config,
        )
    top = result.candidates[:TOP]
    spans = [Span(corpus.file[c.document_id], c.page_start, c.page_end) for c in top]
    return spans, [c.document_id for c in top], gate_fires(result, config)


# --- tier 1: retrieval ---------------------------------------------------------------------------


async def tier1(
    pool: AsyncConnectionPool,
    corpus: Corpus,
    config: RagConfig,
    emb: QueryEmbeddings,
    golden: list[dict[str, Any]],
    synth: list[dict[str, Any]],
) -> dict[str, Any]:
    def block(results: list[tuple[list[Span], list[Span]]]) -> dict[str, Any]:
        out: dict[str, Any] = {"n": len(results)}
        for k in KS:
            out[f"hit_at_{k}"] = round(mean([hit_at(r, g, k) for r, g in results]), 4)
            out[f"recall_at_{k}"] = round(mean([recall_at(r, g, k) for r, g in results]), 4)
        out["mrr"] = round(mean([reciprocal_rank(r, g) for r, g in results]), 4)
        return out

    answerable = [g for g in golden if g["expected"] == "answer" and g["type"] != "follow_up"]
    refusable = [g for g in golden if g["expected"] == "refuse"]
    golden_runs, synth_runs = [], []
    false_gate = 0
    for item in answerable:
        spans, _, gated = await ranked(
            pool, corpus, config, MAIN, item["question"], emb[item["question"]]
        )
        golden_runs.append((spans, gold_spans(item)))
        false_gate += gated
    for item in synth:
        spans, _, _ = await ranked(
            pool, corpus, config, MAIN, item["question"], emb[item["question"]]
        )
        synth_runs.append((spans, gold_spans(item)))
    gate_refused = 0
    for item in refusable:
        _, _, gated = await ranked(
            pool, corpus, config, MAIN, item["question"], emb[item["question"]]
        )
        gate_refused += gated

    leaks = 0
    probe_texts = probes()
    for text in probe_texts:
        _, docs, _ = await ranked(pool, corpus, config, MAIN, text, emb[text])
        leaks += sum(corpus.owner[d] != MAIN for d in docs)
    # Scope probes: another tenant's document ids must be refused outright.
    scope_probes = [
        (MAIN, corpus.of[OTHER]),
        (MAIN, corpus.of[CANARY]),
        (OTHER, corpus.of[MAIN]),
        (CANARY, corpus.of[MAIN]),
    ]
    for tenant, docs in scope_probes:
        try:
            async with pool.connection() as conn, conn.transaction():
                await verify_scope(conn, tenant, docs)
            leaks += 1
        except ScopeMismatch:
            pass

    low, high = wilson(gate_refused, len(refusable))
    return {
        "golden": block(golden_runs),
        "retrieval_synth": {**block(synth_runs), "label": "synthetic, unreviewed"},
        "gate": {
            "refusal_acc": round(gate_refused / max(len(refusable), 1), 4),
            "refusal_ci95": [round(low, 3), round(high, 3)],
            "n_refusable": len(refusable),
            "false_refusal": round(false_gate / max(len(answerable), 1), 4),
            "n_answerable": len(answerable),
        },
        "cross_tenant": {"probes": len(probe_texts) + len(scope_probes), "leaks": leaks},
    }


# --- tier 2: live LLM ----------------------------------------------------------------------------


async def ask(
    pipeline: ChatPipeline, tenant: UUID, docs: list[UUID], question: str, history: list[Any]
) -> dict[str, Any]:
    req = ChatRequest(
        uuid.uuid4(),
        tenant,
        None,
        question,
        [HistoryTurn(h["role"], h["content"]) for h in history],
        docs,
        bypass_cache=True,  # every run measures a real answer, never a cached one
    )
    events = [(e.name, e.payload()) async for e in pipeline.run(req)]
    of = {name: data for name, data in events}
    return {
        "request_id": str(req.request_id),
        "text": "".join(d["d"] for n, d in events if n == "token"),
        "sources": of.get("sources") or [],
        "done": of.get("done"),
        "error": of.get("error"),
        "rewritten": (of.get("meta") or {}).get("rewrittenQuestion"),
    }


async def tier2(
    pool: AsyncConnectionPool,
    corpus: Corpus,
    pipeline: ChatPipeline,
    golden: list[dict[str, Any]],
    canaries: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    gate = asyncio.Semaphore(CONCURRENCY)

    async def run_one(tenant: UUID, item: dict[str, Any]) -> dict[str, Any]:
        async with gate:
            return await ask(
                pipeline, tenant, corpus.of[tenant], item["question"], item.get("history", [])
            )

    answers = await asyncio.gather(*(run_one(MAIN, g) for g in golden))
    attacks = await asyncio.gather(*(run_one(CANARY, c) for c in canaries))

    precision: list[float] = []
    statuses: Counter[str] = Counter()
    uncited = refused_ok = false_refusal = 0
    answerable = [(g, a) for g, a in zip(golden, answers, strict=True) if g["expected"] == "answer"]
    refusable = [(g, a) for g, a in zip(golden, answers, strict=True) if g["expected"] == "refuse"]
    for item, answer in answerable:
        status = (answer["done"] or {}).get("status", "error")
        statuses[status] += 1
        if status in REFUSED:
            false_refusal += 1
            continue
        by_n = {
            s["n"]: Span(corpus.file[UUID(s["documentId"])], s["pageStart"], s["pageEnd"])
            for s in answer["sources"]
        }
        cited = [by_n[n] for n in (answer["done"] or {}).get("citedSources", []) if n in by_n]
        if not cited:
            uncited += 1
            continue
        gold = gold_spans(item)
        precision.append(sum(any(c.overlaps(g) for g in gold) for c in cited) / len(cited))
    for _item, answer in refusable:
        status = (answer["done"] or {}).get("status", "error")
        statuses[status] += 1
        refused_ok += status in REFUSED

    injected, defended_with_fact = 0, 0
    attack_rows = []
    for canary, answer in zip(canaries, attacks, strict=True):
        text = answer["text"].lower()
        hit = canary["marker"].lower() in text
        injected += hit
        defended_with_fact += (not hit) and canary["expected_fact"].lower() in text
        attack_rows.append(
            {
                "id": canary["id"],
                "attack": canary["attack"],
                "injected": hit,
                "answer": answer["text"][:300],
            }
        )

    done = [a["done"] for a in [*answers, *attacks] if a["done"]]
    costs = [d["costUsd"] for d in done]
    latency = [d["latencyMs"]["total"] for d in done]
    low_r, high_r = wilson(refused_ok, len(refusable))
    low_i, high_i = wilson(injected, len(canaries))
    per_item = [
        {
            "id": g["id"],
            "status": (a["done"] or {}).get("status"),
            "rewritten": a["rewritten"],
            "answer": a["text"][:400],
            "request_id": a["request_id"],
        }
        for g, a in zip(golden, answers, strict=True)
    ]
    summary = {
        "citation_precision": round(mean(precision), 4),
        "n_cited_answers": len(precision),
        "answered_without_citation": uncited,
        "refusal_acc": round(refused_ok / max(len(refusable), 1), 4),
        "refusal_ci95": [round(low_r, 3), round(high_r, 3)],
        "false_refusal": round(false_refusal / max(len(answerable), 1), 4),
        "statuses": dict(statuses),
        "injection_success": injected,
        "injection_n": len(canaries),
        "injection_ci95": [round(low_i, 3), round(high_i, 3)],
        "canaries_answered_correctly": defended_with_fact,
        "cost_per_query_usd": round(mean(costs), 8),
        "cost_total_usd": round(sum(costs), 6),
        "latency_ms_p50": percentile(latency, 50),
        "latency_ms_p95": percentile(latency, 95),
        "canaries": attack_rows,
    }
    return summary, per_item


# --- thresholds, stamp, output --------------------------------------------------------------------


def check(results: dict[str, Any]) -> dict[str, str]:
    """Compare against eval/thresholds.yaml: "pass", "FAIL" or "n/a" per metric."""
    thresholds = yaml.safe_load((EVAL_DIR / "thresholds.yaml").read_text())
    flat = {
        "recall_at_5": results["tier1"]["golden"]["recall_at_5"],
        "mrr": results["tier1"]["golden"]["mrr"],
        "gate_refusal_acc": results["tier1"]["gate"]["refusal_acc"],
        "cross_tenant_leaks": results["tier1"]["cross_tenant"]["leaks"],
    }
    if results.get("tier2"):
        t2 = results["tier2"]
        flat |= {
            "refusal_acc": t2["refusal_acc"],
            "false_refusal": t2["false_refusal"],
            "citation_precision": t2["citation_precision"],
            "injection_success": t2["injection_success"],
            "cost_per_query_usd": t2["cost_per_query_usd"],
        }
    verdicts = {}
    for name, rule in thresholds.items():
        if name not in flat:
            verdicts[name] = "n/a"
            continue
        op, value = str(rule).split()
        actual, limit = float(flat[name]), float(value)
        ok = {">=": actual >= limit, "<=": actual <= limit, "==": actual == limit}[op]
        verdicts[name] = f"{'pass' if ok else 'FAIL'} ({flat[name]} {op} {value})"
    return verdicts


async def response_models(pool: AsyncConnectionPool, request_ids: list[str]) -> list[str]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT DISTINCT response_model FROM llm_calls"
            " WHERE request_id = ANY(%s::uuid[]) AND response_model IS NOT NULL",
            (request_ids,),
        )
        return sorted(r[0] for r in await cur.fetchall())


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout.strip()


async def run(args: argparse.Namespace) -> None:
    settings = eval_settings()
    config = RagConfig()
    golden_all = load("golden_v1.jsonl")
    reviewed = [g for g in golden_all if g["review"]["status"] in ("accepted", "edited")]
    golden = golden_all if args.include_pending else reviewed
    if not golden:
        raise SystemExit(
            "No reviewed golden items yet: run make golden-review (or --include-pending)"
        )
    synth = load("retrieval_synth_v1.jsonl")
    canaries = load("canaries_v1.jsonl")

    pool = create_pool(settings, max_size=CONCURRENCY + 2)
    await pool.open(wait=True)
    client = None
    if not args.offline:
        if settings.openai_api_key is None:
            raise SystemExit("OPENAI_API_KEY is required unless --offline")
        client = AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value(), max_retries=2)
    try:
        corpus = await Corpus.load(pool)
        emb = QueryEmbeddings(config.embedding_model, config.embedding_dimensions)
        retrieval_texts = (
            [g["question"] for g in golden] + [s["question"] for s in synth] + probes()
        )
        await emb.ensure(retrieval_texts, client, pool)
        emb.save()
        results: dict[str, Any] = {
            "stamp": {
                "date": datetime.now(UTC).isoformat(timespec="seconds"),
                "git_sha": git("rev-parse", "--short", "HEAD"),
                "git_dirty": bool(git("status", "--porcelain")),
                "config_hash": config.config_hash(),
                "prompt_version": PROMPT_VERSION,
                "chat_model": config.chat_model,
                "datasets": {
                    n: sha(n)
                    for n in ("golden_v1.jsonl", "retrieval_synth_v1.jsonl", "canaries_v1.jsonl")
                },
                "golden_items": len(golden),
                "golden_reviewed": len(reviewed),
                "golden_includes_pending": args.include_pending,
            },
            "tier1": await tier1(pool, corpus, config, emb, golden, synth),
        }
        per_item: list[dict[str, Any]] = []
        if args.tier >= 2 and client is not None:
            pipeline = ChatPipeline(pool, client, CircuitBreaker(5, 60, 30), config)
            results["tier2"], per_item = await tier2(pool, corpus, pipeline, golden, canaries)
            results["stamp"]["response_models"] = await response_models(
                pool, [p["request_id"] for p in per_item]
            )
        results["thresholds"] = check(results)
    finally:
        if client is not None:
            await client.close()
        await pool.close()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = results["stamp"]
    suffix = "-pending" if args.include_pending else ""
    name = f"{stamp['date'][:19].replace(':', '')}-{stamp['git_sha']}{suffix}"
    (RESULTS_DIR / f"{name}.json").write_text(
        json.dumps({**results, "items": per_item}, indent=2, ensure_ascii=False) + "\n"
    )
    print(
        json.dumps(
            {k: v for k, v in results.items() if k != "stamp"}
            | {"file": f"eval/results/{name}.json"},
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", type=int, default=2, choices=(1, 2))
    parser.add_argument("--offline", action="store_true", help="never call OpenAI (tier 1 only)")
    parser.add_argument(
        "--include-pending", action="store_true", help="also unreviewed golden items"
    )
    args = parser.parse_args()
    if args.offline:
        args.tier = 1
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for noisy in ("httpx", "httpx2", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
