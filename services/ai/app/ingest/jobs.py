"""Postgres-backed ingestion queue: SKIP LOCKED claims, leases and fenced state changes.

A worker owns a job only while its lease token matches. Every later write checks the token, so a
worker whose lease expired (and whose job another worker reclaimed) can never commit results.
"""

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from pgvector import HalfVector
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from app.ingest.chunk import Chunk

JobStage = str  # 'downloading' | 'parsing' | 'chunking' | 'embedding' | 'indexing'


class LeaseLost(Exception):
    """The lease expired and the job belongs to another worker now; drop all results."""


class DocumentChanged(Exception):
    """The document left 'processing' (e.g. it was deleted) while it was being ingested."""


@dataclass(frozen=True)
class ClaimedJob:
    job_id: UUID
    document_id: UUID
    tenant_id: UUID
    title: str
    attempts: int
    max_attempts: int
    lease_token: UUID


@dataclass(frozen=True)
class IndexedDocument:
    page_count: int
    chunks: list[Chunk]
    vectors: list[list[float]]
    content_hashes: list[str]
    embedding_model: str
    embed_tokens: int
    embed_cost_usd: Decimal


CLAIM = """
WITH next AS (
    SELECT id FROM ingestion_jobs
     WHERE (status = 'queued' AND run_after <= now())
        OR (status = 'running' AND locked_at < now() - make_interval(secs => %(lease_seconds)s))
     ORDER BY run_after
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE ingestion_jobs AS j
   SET status = 'running', attempts = j.attempts + 1, stage = NULL, locked_at = now(),
       locked_by = %(worker)s, lease_token = gen_random_uuid()
  FROM next
 WHERE j.id = next.id
RETURNING j.id, j.document_id, j.attempts, j.max_attempts, j.lease_token
"""

MARK_PROCESSING = """
UPDATE documents SET status = 'processing'
 WHERE id = %(document_id)s AND status IN ('queued', 'processing')
RETURNING tenant_id, title
"""


async def claim(pool: AsyncConnectionPool, worker: str, lease_seconds: int) -> ClaimedJob | None:
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(CLAIM, {"worker": worker, "lease_seconds": lease_seconds})
        job = await cur.fetchone()
        if job is None:
            return None
        job_id, document_id, attempts, max_attempts, lease_token = job
        cur = await conn.execute(MARK_PROCESSING, {"document_id": document_id})
        doc = await cur.fetchone()
        if doc is None:
            # The document is no longer ingestible (failed or deleting): close the job out.
            await conn.execute(
                "UPDATE ingestion_jobs SET status = 'failed', error_code = 'DOCUMENT_UNAVAILABLE',"
                " locked_at = NULL, lease_token = NULL WHERE id = %s",
                (job_id,),
            )
            return None
        tenant_id, title = doc
        return ClaimedJob(
            job_id, document_id, tenant_id, title, attempts, max_attempts, lease_token
        )


async def _fenced(
    conn: AsyncConnection, job: ClaimedJob, sql: str, params: dict[str, object]
) -> None:
    cur = await conn.execute(sql, {**params, "job_id": job.job_id, "lease": job.lease_token})
    if cur.rowcount == 0:
        raise LeaseLost(f"lease lost for job {job.job_id}")


async def set_stage(pool: AsyncConnectionPool, job: ClaimedJob, stage: JobStage) -> None:
    """Records progress and renews the lease."""
    async with pool.connection() as conn:
        await _fenced(
            conn,
            job,
            "UPDATE ingestion_jobs SET stage = %(stage)s, locked_at = now()"
            " WHERE id = %(job_id)s AND lease_token = %(lease)s",
            {"stage": stage},
        )


async def retry_later(
    pool: AsyncConnectionPool, job: ClaimedJob, code: str, message: str, delay_seconds: int
) -> None:
    async with pool.connection() as conn, conn.transaction():
        await _fenced(
            conn,
            job,
            """UPDATE ingestion_jobs
                  SET status = 'queued', run_after = now() + make_interval(secs => %(delay)s),
                      locked_at = NULL, locked_by = NULL, lease_token = NULL,
                      error_code = %(code)s, last_error = %(message)s
                WHERE id = %(job_id)s AND lease_token = %(lease)s""",
            {"delay": delay_seconds, "code": code, "message": message[:1000]},
        )
        await conn.execute(
            "UPDATE documents SET status = 'queued' WHERE id = %s AND status = 'processing'",
            (job.document_id,),
        )


async def fail(pool: AsyncConnectionPool, job: ClaimedJob, code: str, message: str) -> None:
    async with pool.connection() as conn, conn.transaction():
        await _fenced(
            conn,
            job,
            """UPDATE ingestion_jobs
                  SET status = 'failed', locked_at = NULL, lease_token = NULL,
                      error_code = %(code)s, last_error = %(message)s
                WHERE id = %(job_id)s AND lease_token = %(lease)s""",
            {"code": code, "message": message[:1000]},
        )
        await conn.execute(
            """UPDATE documents SET status = 'failed', error_code = %s, error_message = %s
                WHERE id = %s AND status IN ('queued', 'processing')""",
            (code, message[:1000], job.document_id),
        )


INSERT_CHUNK = """
INSERT INTO chunks (
    document_id, tenant_id, chunk_index, content, section_path, page_start, page_end,
    char_start, token_count, content_hash, embedding_model, embedding
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""


async def finalize(pool: AsyncConnectionPool, job: ClaimedJob, doc: IndexedDocument) -> None:
    """One transaction: close the job (fenced), replace the chunks, mark the document ready."""
    async with pool.connection() as conn, conn.transaction():
        await _fenced(
            conn,
            job,
            "UPDATE ingestion_jobs SET status = 'succeeded', stage = NULL, locked_at = NULL"
            " WHERE id = %(job_id)s AND lease_token = %(lease)s",
            {},
        )
        await conn.execute("DELETE FROM chunks WHERE document_id = %s", (job.document_id,))
        async with conn.cursor() as cur:
            await cur.executemany(
                INSERT_CHUNK,
                [
                    (
                        job.document_id,
                        job.tenant_id,
                        c.index,
                        c.content,
                        c.section_path,
                        c.page_start,
                        c.page_end,
                        c.char_start,
                        c.token_count,
                        h,
                        doc.embedding_model,
                        HalfVector(v),
                    )
                    for c, v, h in zip(doc.chunks, doc.vectors, doc.content_hashes, strict=True)
                ],
            )
        cur = await conn.execute(
            """UPDATE documents
                  SET status = 'ready', page_count = %s, chunk_count = %s, embed_tokens = %s,
                      embed_cost_usd = %s, error_code = NULL, error_message = NULL, ready_at = now()
                WHERE id = %s AND status = 'processing'""",
            (
                doc.page_count,
                len(doc.chunks),
                doc.embed_tokens,
                doc.embed_cost_usd,
                job.document_id,
            ),
        )
        if cur.rowcount == 0:
            raise DocumentChanged(f"document {job.document_id} is no longer processing")
