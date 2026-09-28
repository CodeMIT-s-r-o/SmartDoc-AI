"""Document embeddings in batches; every API call is reported for the cost ledger."""

import hashlib
import time
from collections.abc import Awaitable, Callable, Sequence

from openai import AsyncOpenAI

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
BATCH_SIZE = 256

# (prompt_tokens, latency_ms) of one embeddings call.
UsageCallback = Callable[[int, int], Awaitable[None]]


def embedding_input(title: str, section_path: str | None, content: str) -> str:
    """Contextual header: the chunk is embedded with its document title and section path."""
    header = f"{title} > {section_path}" if section_path else title
    return f"{header}\n\n{content}"


def content_hash(model: str, text: str) -> str:
    """Identifies a vector: same model + same embedded input = reusable embedding."""
    return hashlib.sha256(f"{model}\n{text}".encode()).hexdigest()


async def embed_texts(
    client: AsyncOpenAI,
    texts: Sequence[str],
    on_usage: UsageCallback,
    *,
    model: str = EMBEDDING_MODEL,
    dimensions: int = EMBEDDING_DIMENSIONS,
) -> list[list[float]]:
    vectors: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = list(texts[i : i + BATCH_SIZE])
        started = time.perf_counter()
        res = await client.embeddings.create(model=model, input=batch, dimensions=dimensions)
        await on_usage(res.usage.prompt_tokens, round((time.perf_counter() - started) * 1000))
        vectors.extend(item.embedding for item in sorted(res.data, key=lambda d: d.index))
    if len(vectors) != len(texts):
        raise RuntimeError(f"expected {len(texts)} embeddings, got {len(vectors)}")
    return vectors
