"""The ingestion queue against a real, migrated Postgres (make test-db, database smartdoc_test)."""

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from decimal import Decimal

import pytest
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.db import create_pool
from app.ingest import jobs
from app.ingest.chunk import Chunk

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set"),
    pytest.mark.anyio,
]
LEASE_S = 900


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def pool() -> AsyncIterator[AsyncConnectionPool]:
    assert DATABASE_URL is not None
    p = create_pool(Settings(database_url=DATABASE_URL), max_size=4)
    await p.open(wait=True)
    async with p.connection() as conn:
        # Tests own this database: start from an empty queue so claims are deterministic.
        await conn.execute("DELETE FROM users WHERE email LIKE '%@jobs.test'")
    yield p
    async with p.connection() as conn:
        await conn.execute("DELETE FROM users WHERE email LIKE '%@jobs.test'")
    await p.close()


async def enqueue(
    pool: AsyncConnectionPool, *, run_after_s: int = 0
) -> tuple[uuid.UUID, uuid.UUID]:
    """A tenant with one queued document and its job. Returns (tenant_id, document_id)."""
    tenant, doc = uuid.uuid4(), uuid.uuid4()
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO users (id, email) VALUES (%s, %s)", (tenant, f"{tenant}@jobs.test")
        )
        await conn.execute(
            """INSERT INTO documents (id, tenant_id, title, original_filename, s3_key,
                                      s3_version_id, size_bytes, status)
               VALUES (%s, %s, 'Handbook', 'Handbook.pdf', 'k', 'v1', 1000, 'queued')""",
            (doc, tenant),
        )
        await conn.execute(
            "INSERT INTO ingestion_jobs (document_id, run_after)"
            " VALUES (%s, now() + make_interval(secs => %s))",
            (doc, run_after_s),
        )
    return tenant, doc


async def one(pool: AsyncConnectionPool, sql: str, *params: object) -> tuple[object, ...]:
    async with pool.connection() as conn:
        row = await (await conn.execute(sql, params)).fetchone()
    assert row is not None
    return tuple(row)


def indexed(n: int) -> jobs.IndexedDocument:
    chunks = [Chunk(i, f"chunk {i}", "1 Leave", 1, 1, i * 10, 3) for i in range(n)]
    return jobs.IndexedDocument(
        page_count=2,
        chunks=chunks,
        vectors=[[0.01 * (i + 1)] * 1536 for i in range(n)],
        content_hashes=[f"h{i}" for i in range(n)],
        embedding_model="text-embedding-3-small",
        embed_tokens=42,
        embed_cost_usd=Decimal("0.00000084"),
    )


async def test_claim_on_an_empty_queue_returns_none(pool: AsyncConnectionPool) -> None:
    assert await jobs.claim(pool, "w1", LEASE_S) is None


async def test_claim_takes_the_job_and_marks_the_document_processing(
    pool: AsyncConnectionPool,
) -> None:
    tenant, doc = await enqueue(pool)

    job = await jobs.claim(pool, "w1", LEASE_S)

    assert job is not None
    assert (job.document_id, job.tenant_id, job.title, job.attempts) == (doc, tenant, "Handbook", 1)
    assert await one(
        pool, "SELECT status, locked_by FROM ingestion_jobs WHERE id = %s", job.job_id
    ) == (
        "running",
        "w1",
    )
    assert await one(pool, "SELECT status FROM documents WHERE id = %s", doc) == ("processing",)


async def test_concurrent_claims_never_share_a_job(pool: AsyncConnectionPool) -> None:
    await enqueue(pool)

    results = await asyncio.gather(*(jobs.claim(pool, f"w{i}", LEASE_S) for i in range(4)))

    assert sum(r is not None for r in results) == 1


async def test_jobs_scheduled_for_later_are_not_claimed(pool: AsyncConnectionPool) -> None:
    await enqueue(pool, run_after_s=60)
    assert await jobs.claim(pool, "w1", LEASE_S) is None


async def test_an_expired_lease_is_reclaimed_and_fences_out_the_old_worker(
    pool: AsyncConnectionPool,
) -> None:
    await enqueue(pool)
    stale = await jobs.claim(pool, "crashed", LEASE_S)
    assert stale is not None
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE ingestion_jobs SET locked_at = now() - interval '20 minutes' WHERE id = %s",
            (stale.job_id,),
        )

    fresh = await jobs.claim(pool, "w2", LEASE_S)

    assert fresh is not None and fresh.job_id == stale.job_id
    assert fresh.attempts == 2 and fresh.lease_token != stale.lease_token
    with pytest.raises(jobs.LeaseLost):
        await jobs.set_stage(pool, stale, "parsing")
    with pytest.raises(jobs.LeaseLost):
        await jobs.finalize(pool, stale, indexed(1))
    await jobs.set_stage(pool, fresh, "parsing")


async def test_retry_requeues_the_job_and_the_document(pool: AsyncConnectionPool) -> None:
    _, doc = await enqueue(pool)
    job = await jobs.claim(pool, "w1", LEASE_S)
    assert job is not None

    await jobs.retry_later(pool, job, "INGESTION_FAILED", "OpenAI timeout", delay_seconds=60)

    status, error, delay = await one(
        pool,
        "SELECT status, error_code, extract(epoch FROM run_after - now())"
        " FROM ingestion_jobs WHERE id = %s",
        job.job_id,
    )
    assert (status, error) == ("queued", "INGESTION_FAILED")
    assert 50 < float(delay) <= 60  # type: ignore[arg-type]
    assert await one(pool, "SELECT status FROM documents WHERE id = %s", doc) == ("queued",)
    assert await jobs.claim(pool, "w1", LEASE_S) is None


async def test_fail_records_the_code_on_the_job_and_the_document(pool: AsyncConnectionPool) -> None:
    _, doc = await enqueue(pool)
    job = await jobs.claim(pool, "w1", LEASE_S)
    assert job is not None

    await jobs.fail(pool, job, "NO_TEXT_LAYER", "Most pages have no text layer")

    assert await one(
        pool, "SELECT status, error_code FROM ingestion_jobs WHERE id = %s", job.job_id
    ) == (
        "failed",
        "NO_TEXT_LAYER",
    )
    assert await one(pool, "SELECT status, error_code FROM documents WHERE id = %s", doc) == (
        "failed",
        "NO_TEXT_LAYER",
    )


async def test_finalize_indexes_chunks_and_marks_the_document_ready(
    pool: AsyncConnectionPool,
) -> None:
    tenant, doc = await enqueue(pool)
    job = await jobs.claim(pool, "w1", LEASE_S)
    assert job is not None

    await jobs.finalize(pool, job, indexed(3))

    assert await one(
        pool,
        "SELECT status, page_count, chunk_count, embed_tokens, embed_cost_usd"
        " FROM documents WHERE id = %s",
        doc,
    ) == ("ready", 2, 3, 42, Decimal("0.0000008400"))
    count, tenants, dims = await one(
        pool,
        "SELECT count(*), count(DISTINCT tenant_id), max(vector_dims(embedding))"
        " FROM chunks WHERE document_id = %s",
        doc,
    )
    assert (count, dims) == (3, 1536)
    assert tenants == 1
    assert await one(pool, "SELECT status FROM ingestion_jobs WHERE id = %s", job.job_id) == (
        "succeeded",
    )
    assert await one(pool, "SELECT tenant_id FROM chunks WHERE document_id = %s LIMIT 1", doc) == (
        tenant,
    )


async def test_finalize_rolls_back_when_the_document_changed_meanwhile(
    pool: AsyncConnectionPool,
) -> None:
    _, doc = await enqueue(pool)
    job = await jobs.claim(pool, "w1", LEASE_S)
    assert job is not None
    async with pool.connection() as conn:
        await conn.execute("UPDATE documents SET status = 'deleting' WHERE id = %s", (doc,))

    with pytest.raises(jobs.DocumentChanged):
        await jobs.finalize(pool, job, indexed(2))

    assert await one(pool, "SELECT count(*) FROM chunks WHERE document_id = %s", doc) == (0,)
    assert await one(pool, "SELECT status FROM ingestion_jobs WHERE id = %s", job.job_id) == (
        "running",
    )


async def test_a_job_whose_document_is_gone_is_closed_at_claim_time(
    pool: AsyncConnectionPool,
) -> None:
    _, doc = await enqueue(pool)
    async with pool.connection() as conn:
        await conn.execute("UPDATE documents SET status = 'failed' WHERE id = %s", (doc,))

    assert await jobs.claim(pool, "w1", LEASE_S) is None
    assert await one(
        pool, "SELECT status, error_code FROM ingestion_jobs WHERE document_id = %s", doc
    ) == (
        "failed",
        "DOCUMENT_UNAVAILABLE",
    )
