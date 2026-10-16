from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.rag.cache import normalize_question, question_hash, scope_hash

A = UUID("00000000-0000-4000-8000-00000000000a")
B = UUID("00000000-0000-4000-8000-00000000000b")
READY = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def test_spelling_variants_of_one_question_share_a_key() -> None:
    variants = [
        "How many days of annual leave do I get?",
        "  how many days of annual   leave do I get ",
        "HOW MANY DAYS OF ANNUAL LEAVE DO I GET?!",
        "How many days of annual leave do I get。".replace("。", "."),
    ]
    assert {question_hash(v) for v in variants} == {question_hash(variants[0])}
    assert normalize_question(variants[1]) == "how many days of annual leave do i get"


def test_different_questions_do_not_collide() -> None:
    assert question_hash("Leave in 2026?") != question_hash("Leave in 2025?")


def test_scope_ignores_order_but_not_documents_config_or_prompt() -> None:
    base = scope_hash("cfg", "v1", {A: READY, B: READY})

    assert scope_hash("cfg", "v1", {B: READY, A: READY}) == base
    assert scope_hash("cfg", "v1", {A: READY}) != base  # a document left the scope
    assert scope_hash("cfg", "v1", {A: READY, B: READY + timedelta(seconds=1)}) != base  # re-ingest
    assert scope_hash("cfg2", "v1", {A: READY, B: READY}) != base  # another model or retrieval
    assert scope_hash("cfg", "v2", {A: READY, B: READY}) != base  # another prompt
