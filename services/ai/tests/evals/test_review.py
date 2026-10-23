import json
from pathlib import Path

import pytest

from evals import review

ITEM = {
    "id": "g-1",
    "type": "single_hop",
    "question": "How long is basic leave?",
    "expected": "answer",
    "answer": "Four weeks.",
    "evidence": [{"document": "a.pdf", "pages": [58, 58], "quote": "at least four weeks"}],
    "review": {"status": "pending", "notes": ""},
}


@pytest.fixture
def dataset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "golden_v1.jsonl"
    path.write_text(json.dumps(ITEM) + "\n")
    monkeypatch.setattr(review, "DATASETS_DIR", tmp_path)
    return path


def saved(path: Path) -> dict[str, object]:
    row: dict[str, object] = json.loads(path.read_text().splitlines()[0])
    return row


def test_accepting_records_the_decision_and_changes_nothing_else(dataset: Path) -> None:
    review.apply("golden", "g-1", {"status": "accepted", "notes": "ok", "pages": [58, 58]})

    row = saved(dataset)
    assert row["review"] == {
        "status": "accepted",
        "notes": "ok",
        "reviewed_at": row["review"]["reviewed_at"],
    }  # type: ignore[index]
    assert "original" not in row and row["answer"] == "Four weeks."


def test_an_edit_keeps_the_generated_original_next_to_the_fix(dataset: Path) -> None:
    review.apply(
        "golden",
        "g-1",
        {
            "status": "edited",
            "edits": {"answer": "At least four weeks.", "id": "x"},
            "pages": [57, 58],
        },
    )

    row = saved(dataset)
    assert row["answer"] == "At least four weeks." and row["id"] == "g-1"
    assert row["original"] == {"answer": "Four weeks.", "pages": [58, 58]}
    assert row["evidence"][0]["pages"] == [57, 58]  # type: ignore[index]


def test_rejects_unknown_statuses_and_items(dataset: Path) -> None:
    with pytest.raises(ValueError):
        review.apply("golden", "g-1", {"status": "maybe"})
    with pytest.raises(KeyError):
        review.apply("golden", "nope", {"status": "accepted"})
