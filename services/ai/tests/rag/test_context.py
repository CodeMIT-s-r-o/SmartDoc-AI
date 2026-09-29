import uuid

from app.rag.config import RagConfig
from app.rag.context import assemble, snippet
from app.rag.retrieve import Candidate


def cand(tokens: int, content_hash: str | None = None) -> Candidate:
    return Candidate(
        chunk_id=uuid.uuid4(),
        document_id=uuid.uuid4(),
        title="T",
        section_path=None,
        page_start=1,
        page_end=1,
        content="text",
        content_hash=content_hash or uuid.uuid4().hex,
        token_count=tokens,
        vector_score=0.5,
        fts_rank=None,
        matched_lexemes=None,
        rrf_score=0.01,
    )


def test_takes_the_best_first_up_to_top_k() -> None:
    chosen = assemble([cand(100) for _ in range(9)], RagConfig(top_k=5))
    assert [c.n for c in chosen] == [1, 2, 3, 4, 5]


def test_stops_at_the_token_budget_but_always_keeps_one() -> None:
    assert (
        len(assemble([cand(900), cand(900), cand(900)], RagConfig(context_token_budget=2000))) == 2
    )
    assert len(assemble([cand(5000)], RagConfig(context_token_budget=2000))) == 1


def test_drops_duplicate_content() -> None:
    chosen = assemble([cand(10, "same"), cand(10, "same"), cand(10)], RagConfig())
    assert len(chosen) == 2


def test_snippet_is_short_and_single_line() -> None:
    assert snippet("a\n\nb") == "a b"
    assert len(snippet("word " * 200)) <= 400
