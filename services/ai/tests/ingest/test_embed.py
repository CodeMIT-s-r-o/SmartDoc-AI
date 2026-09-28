from dataclasses import dataclass
from typing import Any

import pytest

from app.ingest.embed import BATCH_SIZE, content_hash, embed_texts, embedding_input


@dataclass
class _Item:
    index: int
    embedding: list[float]


@dataclass
class _Usage:
    prompt_tokens: int


@dataclass
class _Response:
    data: list[_Item]
    usage: _Usage


class FakeEmbeddings:
    def __init__(self) -> None:
        self.batches: list[int] = []

    async def create(self, *, model: str, input: list[str], dimensions: int) -> _Response:
        self.batches.append(len(input))
        # Return items out of order: the caller must sort by index.
        items = [_Item(i, [float(len(text)), float(dimensions)]) for i, text in enumerate(input)]
        return _Response(list(reversed(items)), _Usage(prompt_tokens=10 * len(input)))


class FakeClient:
    def __init__(self) -> None:
        self.embeddings = FakeEmbeddings()


@pytest.mark.anyio
async def test_batches_calls_reports_usage_per_call_and_keeps_order() -> None:
    client = FakeClient()
    usage: list[int] = []

    async def on_usage(tokens: int, latency_ms: int) -> None:
        usage.append(tokens)

    texts = [f"text {'x' * (i % 7)}" for i in range(600)]
    vectors = await embed_texts(client, texts, on_usage)  # type: ignore[arg-type]

    assert client.embeddings.batches == [BATCH_SIZE, BATCH_SIZE, 600 - 2 * BATCH_SIZE]
    assert usage == [2560, 2560, 880]
    assert [v[0] for v in vectors] == [float(len(t)) for t in texts]


def test_embedding_input_carries_title_and_section() -> None:
    assert embedding_input("Handbook", "4 Leave > 4.2 Annual", "25 days.") == (
        "Handbook > 4 Leave > 4.2 Annual\n\n25 days."
    )
    assert embedding_input("Handbook", None, "25 days.") == "Handbook\n\n25 days."


def test_content_hash_depends_on_model_and_input() -> None:
    assert content_hash("m1", "a") == content_hash("m1", "a")
    assert content_hash("m1", "a") != content_hash("m2", "a")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


_ = Any
