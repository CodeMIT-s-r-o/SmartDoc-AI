"""Ingest the eval corpus into smartdoc_eval through the real worker code.

    make eval-ingest

Each document is queued exactly like an upload and processed by app.ingest.pipeline.process_job
(sandboxed parse, chunking, embedding with ledger rows, fenced finalize); only the bytes come from
a local file instead of S3. Idempotent: a document whose SHA-256 is already ready is skipped.
"""

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.db import create_pool
from app.ingest import jobs
from app.ingest.pipeline import WorkerDeps, process_job
from evals.canaries import CANARIES
from evals.env import CANARY, CORPUS_DIR, GENERATED_DIR, MAIN, OTHER, TENANTS, eval_settings
from evals.pdfs import write_canary, write_northwind

log = logging.getLogger("evals.ingest")
LEASE_SECONDS = 900


@dataclass(frozen=True)
class EvalDocument:
    tenant: UUID
    path: Path
    title: str


def documents() -> list[EvalDocument]:
    manifest = json.loads((CORPUS_DIR / "manifest.json").read_text())
    docs = [EvalDocument(MAIN, CORPUS_DIR / d["file"], d["title"]) for d in manifest["documents"]]
    northwind = GENERATED_DIR / "northwind-staff-handbook.pdf"
    write_northwind(northwind)
    docs.append(EvalDocument(OTHER, northwind, "Northwind Ltd. Staff Handbook"))
    for canary in CANARIES:
        path = GENERATED_DIR / f"canary-{canary.id}.pdf"
        write_canary(canary, path)
        docs.append(EvalDocument(CANARY, path, canary.title))
    return docs


async def ensure_tenants(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        for name, tenant_id in TENANTS.items():
            await conn.execute(
                "INSERT INTO users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (tenant_id, f"{name}@eval.smartdoc.local"),
            )


async def enqueue(pool: AsyncConnectionPool, doc: EvalDocument) -> UUID | None:
    """Queue the document like /complete does; None when the same bytes are already ready."""
    data = doc.path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """SELECT id, status FROM documents
                WHERE tenant_id = %s AND sha256 = %s AND status NOT IN ('failed', 'deleting')""",
            (doc.tenant, sha),
        )
        existing = await cur.fetchone()
        if existing and existing[1] == "ready":
            return None
        if existing:  # interrupted earlier: start that document over
            await conn.execute("DELETE FROM documents WHERE id = %s", (existing[0],))
        document_id = uuid4()
        await conn.execute(
            """INSERT INTO documents (id, tenant_id, title, original_filename, s3_key,
                                      s3_version_id, size_bytes, sha256, status)
               VALUES (%s, %s, %s, %s, %s, 'local', %s, %s, 'queued')""",
            (
                document_id,
                doc.tenant,
                doc.title,
                doc.path.name,
                f"local/{doc.path.name}",
                len(data),
                sha,
            ),
        )
        await conn.execute("INSERT INTO ingestion_jobs (document_id) VALUES (%s)", (document_id,))
    return document_id


async def run() -> None:
    settings = eval_settings()
    if settings.openai_api_key is None:
        raise SystemExit("OPENAI_API_KEY is required (set it in .env)")
    docs = documents()
    paths = {}
    pool = create_pool(settings, max_size=2)
    await pool.open(wait=True)
    try:
        await ensure_tenants(pool)
        for doc in docs:
            document_id = await enqueue(pool, doc)
            if document_id is None:
                log.info("ready already: %s", doc.path.name)
            else:
                paths[document_id] = doc.path

        async def local_file(job: jobs.ClaimedJob) -> bytes:
            return paths[job.document_id].read_bytes()

        async with (
            httpx.AsyncClient() as http,
            AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value(), max_retries=2) as ai,
        ):
            deps = WorkerDeps(pool=pool, http=http, openai=ai, api_url="", internal_token="")
            while (job := await jobs.claim(pool, "evals.ingest", LEASE_SECONDS)) is not None:
                indexed = await process_job(deps, job, source=local_file)
                log.info(
                    "%-40s %3d pages %4d chunks %6d tokens $%s",
                    paths[job.document_id].name,
                    indexed.page_count,
                    len(indexed.chunks),
                    indexed.embed_tokens,
                    indexed.embed_cost_usd,
                )
    finally:
        await pool.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(run())
