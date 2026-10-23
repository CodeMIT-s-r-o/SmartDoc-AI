"""One ingestion job: download -> parse (sandboxed) -> chunk -> embed -> index."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal

import httpx
from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.cost.ledger import record_llm_call
from app.ingest import jobs
from app.ingest.chunk import chunk_document
from app.ingest.download import download_document
from app.ingest.embed import EMBEDDING_MODEL, content_hash, embed_texts, embedding_input
from app.ingest.errors import NO_TEXT_LAYER, permanent
from app.ingest.parse_pdf import parse_pdf
from app.ingest.sandbox import run_limited


@dataclass
class _EmbedUsage:
    tokens: int = 0
    cost: Decimal = Decimal(0)


@dataclass(frozen=True)
class WorkerDeps:
    pool: AsyncConnectionPool
    http: httpx.AsyncClient
    openai: AsyncOpenAI
    api_url: str
    internal_token: str


# Where a job's PDF bytes come from: the API's presigned S3 URL in the worker, a local file in the
# eval harness (evals/ingest.py), so both run the same parse -> chunk -> embed -> index code.
DocumentSource = Callable[[jobs.ClaimedJob], Awaitable[bytes]]


async def process_job(
    deps: WorkerDeps, job: jobs.ClaimedJob, source: DocumentSource | None = None
) -> jobs.IndexedDocument:
    await jobs.set_stage(deps.pool, job, "downloading")
    if source is None:
        data = await download_document(
            deps.http, deps.api_url, deps.internal_token, job.document_id
        )
    else:
        data = await source(job)

    await jobs.set_stage(deps.pool, job, "parsing")
    parsed = await asyncio.to_thread(run_limited, parse_pdf, data)

    await jobs.set_stage(deps.pool, job, "chunking")
    chunks = await asyncio.to_thread(chunk_document, parsed)
    if not chunks:
        raise permanent(NO_TEXT_LAYER, "The PDF contains no extractable text")

    await jobs.set_stage(deps.pool, job, "embedding")
    inputs = [embedding_input(job.title, c.section_path, c.content) for c in chunks]
    usage = _EmbedUsage()

    async def on_usage(prompt_tokens: int, latency_ms: int) -> None:
        # Each call is in the ledger before the next one starts, even if the job fails later.
        cost = await record_llm_call(
            deps.pool,
            tenant_id=job.tenant_id,
            purpose="doc_embed",
            model=EMBEDDING_MODEL,
            input_tokens=prompt_tokens,
            document_id=job.document_id,
            latency_ms=latency_ms,
        )
        usage.tokens += prompt_tokens
        usage.cost += cost

    vectors = await embed_texts(deps.openai, inputs, on_usage)

    await jobs.set_stage(deps.pool, job, "indexing")
    indexed = jobs.IndexedDocument(
        page_count=parsed.page_count,
        chunks=chunks,
        vectors=vectors,
        content_hashes=[content_hash(EMBEDDING_MODEL, text) for text in inputs],
        embedding_model=EMBEDDING_MODEL,
        embed_tokens=usage.tokens,
        embed_cost_usd=usage.cost,
    )
    await jobs.finalize(deps.pool, job, indexed)
    return indexed
