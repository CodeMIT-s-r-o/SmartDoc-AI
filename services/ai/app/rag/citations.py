"""Citation markers in answers: [1], [2, 3]."""

import re
from dataclasses import dataclass

_MARKER = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class CitationReport:
    cited: list[int]
    """Every cited number refers to a document that was in the prompt (a sanity check only)."""
    valid: bool
    """Share of sentences that carry at least one marker."""
    coverage: float


def parse_citations(answer: str, context_size: int) -> CitationReport:
    cited = sorted({int(n) for group in _MARKER.findall(answer) for n in group.split(",")})
    sentences = [s for s in _SENTENCE_END.split(answer.strip()) if s.strip()]
    with_marker = sum(1 for s in sentences if _MARKER.search(s))
    return CitationReport(
        cited=cited,
        valid=all(1 <= n <= context_size for n in cited),
        coverage=with_marker / len(sentences) if sentences else 0.0,
    )


def strip_markers(text: str) -> str:
    """History goes back to the model without markers: their numbers referred to another prompt."""
    return re.sub(r"\s*" + _MARKER.pattern, "", text)
