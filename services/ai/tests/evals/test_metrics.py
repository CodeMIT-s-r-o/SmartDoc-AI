import pytest

from evals.metrics import Span, hit_at, percentile, recall_at, reciprocal_rank, wilson

GOLD = [Span("labour.pdf", 58, 58)]
RANKED = [Span("labour.pdf", 12, 13), Span("data.pdf", 58, 58), Span("labour.pdf", 57, 58)]


def test_relevance_is_the_gold_document_with_overlapping_pages() -> None:
    assert not Span("data.pdf", 58, 58).overlaps(GOLD[0])  # same page, other document
    assert Span("labour.pdf", 57, 58).overlaps(GOLD[0])
    assert not Span("labour.pdf", 59, 60).overlaps(GOLD[0])


def test_hit_and_reciprocal_rank_use_the_first_relevant_passage() -> None:
    assert reciprocal_rank(RANKED, GOLD) == pytest.approx(1 / 3)
    assert not hit_at(RANKED, GOLD, 2) and hit_at(RANKED, GOLD, 3)
    assert reciprocal_rank(RANKED[:2], GOLD) == 0.0


def test_recall_counts_each_gold_span_of_a_multi_hop_item() -> None:
    gold = [Span("labour.pdf", 12, 12), Span("labour.pdf", 90, 90)]

    assert recall_at(RANKED, gold, 3) == 0.5


def test_wilson_interval_is_honest_about_zero_successes() -> None:
    low, high = wilson(0, 12)

    assert low == 0.0 and high == pytest.approx(0.2425, abs=1e-3)  # "0/12" is not "0 %"
    assert wilson(40, 40)[0] == pytest.approx(0.912, abs=1e-3)


def test_percentile_is_nearest_rank() -> None:
    assert percentile([5, 1, 3, 2, 4], 50) == 3
    assert percentile([5, 1, 3, 2, 4], 95) == 5
    assert percentile([], 95) == 0.0
