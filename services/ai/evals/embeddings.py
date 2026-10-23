"""Question embeddings, cached in eval/fixtures so retrieval metrics need no API call (tier 1, CI).

Stored as half precision (the corpus vectors are halfvec too), base64 in gzipped JSON lines,
keyed by sha256(model:dimensions:text). A missing embedding is fetched once and booked in the
eval ledger; with `offline=True` (CI) it is an error instead.
"""

import base64
import gzip
import hashlib
import json
import struct
import time
from collections.abc import Sequence

from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.cost.ledger import record_llm_call
from evals.env import FIXTURES_DIR, MAIN

CACHE = FIXTURES_DIR / "query_embeddings.jsonl.gz"
BATCH = 64


def _encode(vector: Sequence[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode()


def _decode(data: str) -> list[float]:
    raw = base64.b64decode(data)
    return list(struct.unpack(f"<{len(raw) // 2}e", raw))


class QueryEmbeddings:
    def __init__(self, model: str, dimensions: int) -> None:
        self.model, self.dimensions = model, dimensions
        self.vectors: dict[str, list[float]] = {}
        self.added = 0
        if CACHE.exists():
            with gzip.open(CACHE, "rt") as f:
                for line in f:
                    row = json.loads(line)
                    self.vectors[row["key"]] = _decode(row["vector"])

    def key(self, text: str) -> str:
        return hashlib.sha256(f"{self.model}:{self.dimensions}:{text}".encode()).hexdigest()

    def __getitem__(self, text: str) -> list[float]:
        return self.vectors[self.key(text)]

    async def ensure(
        self,
        texts: Sequence[str],
        client: AsyncOpenAI | None,
        pool: AsyncConnectionPool,
    ) -> None:
        missing = sorted({t for t in texts if self.key(t) not in self.vectors})
        if missing and client is None:
            raise SystemExit(
                f"{len(missing)} question embeddings are not in {CACHE.name}; "
                "run make eval once with an OpenAI key"
            )
        assert client is not None or not missing
        for start in range(0, len(missing), BATCH):
            batch = missing[start : start + BATCH]
            began = time.perf_counter()
            res = await client.embeddings.create(  # type: ignore[union-attr]
                model=self.model, input=batch, dimensions=self.dimensions
            )
            await record_llm_call(
                pool,
                tenant_id=MAIN,
                purpose="eval",
                model=self.model,
                input_tokens=res.usage.prompt_tokens,
                latency_ms=round((time.perf_counter() - began) * 1000),
            )
            for text, item in zip(batch, res.data, strict=True):
                # Keep exactly what the cache will hold, so a live run and CI query alike.
                self.vectors[self.key(text)] = _decode(_encode(item.embedding))
                self.added += 1

    def save(self) -> None:
        if not self.added:
            return
        FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
        lines = "".join(
            json.dumps({"key": key, "vector": _encode(vector)}) + "\n"
            for key, vector in sorted(self.vectors.items())
        )
        # No timestamp or file name in the gzip header: same content, same bytes, no git noise.
        with (
            CACHE.open("wb") as raw,
            gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0) as gz,
        ):
            gz.write(lines.encode())
