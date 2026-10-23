"""Eval metrics as pure functions (docs/IMPLEMENTATION_PLAN.md §8).

Ground truth is (document, page range), never chunk ids: a retrieved passage is relevant when it
comes from the gold document and its pages overlap the gold pages. Re-chunking therefore does
not invalidate the datasets.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Span:
    document: str
    page_start: int
    page_end: int

    def overlaps(self, other: "Span") -> bool:
        return (
            self.document == other.document
            and self.page_start <= other.page_end
            and other.page_start <= self.page_end
        )


def first_hit(ranked: Sequence[Span], gold: Sequence[Span]) -> int | None:
    """1-based rank of the first retrieved span that overlaps any gold span."""
    for rank, span in enumerate(ranked, start=1):
        if any(span.overlaps(g) for g in gold):
            return rank
    return None


def hit_at(ranked: Sequence[Span], gold: Sequence[Span], k: int) -> bool:
    rank = first_hit(ranked, gold)
    return rank is not None and rank <= k


def recall_at(ranked: Sequence[Span], gold: Sequence[Span], k: int) -> float:
    """Share of gold spans (multi-hop items have several) found in the top k."""
    top = ranked[:k]
    return sum(any(s.overlaps(g) for s in top) for g in gold) / len(gold)


def reciprocal_rank(ranked: Sequence[Span], gold: Sequence[Span]) -> float:
    rank = first_hit(ranked, gold)
    return 0.0 if rank is None else 1.0 / rank


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95 % Wilson score interval: honest for small n and for 0 or n successes."""
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile (q in 0..100); 0 for an empty list."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100 * len(ordered)))
    return ordered[rank - 1]
