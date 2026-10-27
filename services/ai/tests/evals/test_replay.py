import random

import pytest

from evals.replay import traffic, web_summary


def arm(name: str, per_1k: float) -> dict[str, object]:
    return {
        "arm": name,
        "cost_per_1k_queries_usd": per_1k,
        "cost_p50_usd": per_1k / 1000,
        "prompt_cache_token_share": 0.3,
        "latency_ms_p50": 2000.0,
        "latency_ms_p95": 4000.0,
        "statuses": {"answered": 9},
    }


RESULT = {
    "label": "synthetic replay traffic (2026-10-26)",
    "date": "2026-10-26T21:25:32+00:00",
    "git_sha": "427784a",
    "requests_per_arm": 200,
    "repeats": 40,
    "arms": [arm("naive", 0.56), arm("sensible", 0.36), arm("optimized", 0.25)],
    "optimized_attribution": {
        "exact_cache_usd": 0.004,
        "prompt_cache_usd": 0.016,
        "gate_refusals": 3,
    },
}


def test_the_waterfall_runs_from_naive_to_optimized_and_adds_up() -> None:
    steps = web_summary(RESULT)["waterfall"]

    assert [s["usdPer1k"] for s in steps] == pytest.approx([0.56, -0.2, -0.02, -0.08, -0.01, 0.25])
    assert sum(s["usdPer1k"] for s in steps if s["kind"] == "step") == pytest.approx(0.25 - 0.56)


def test_repeats_are_a_fifth_of_the_traffic_and_only_repeat_earlier_questions() -> None:
    items = traffic(random.Random(26))

    repeats = [i for i, item in enumerate(items) if item.get("repeat")]
    assert len(repeats) / len(items) == pytest.approx(0.2, abs=0.01)
    for position in repeats:
        earlier = {i["question"] for i in items[:position] if not i.get("repeat")}
        assert items[position]["question"] in earlier
