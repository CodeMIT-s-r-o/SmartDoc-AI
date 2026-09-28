"""Ingestion worker: `python -m app.ingest.worker`.

Polls the Postgres queue every 2 s and ingests one document at a time. Permanent failures (bad
PDFs) fail the job at once; everything else is retried after 30 s * 2^attempts, at most
`max_attempts` times. A crashed worker's job is reclaimed when its lease expires.
"""

import asyncio
import contextlib
import logging
import os
import signal
import socket
from pathlib import Path

import httpx
from openai import AsyncOpenAI

from app.config import get_settings
from app.db import create_pool
from app.ingest import jobs
from app.ingest.errors import (
    ATTEMPTS_EXHAUSTED,
    DOCUMENT_UNAVAILABLE,
    INGESTION_FAILED,
    IngestError,
)
from app.ingest.pipeline import WorkerDeps, process_job

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("worker")

POLL_INTERVAL_S = 2.0
HEARTBEAT_INTERVAL_S = 5.0
RETRY_BASE_SECONDS = 30
POOL_MAX_SIZE = 2
HEARTBEAT_FILE = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/worker-heartbeat"))


async def heartbeat(deps: WorkerDeps, stop: asyncio.Event) -> None:
    """The container is healthy while the event loop runs and the database answers."""
    while not stop.is_set():
        try:
            async with deps.pool.connection(timeout=HEARTBEAT_INTERVAL_S) as conn:
                await conn.execute("select 1")
            await asyncio.to_thread(HEARTBEAT_FILE.touch)
        except Exception:
            log.warning("database unreachable", exc_info=True)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_INTERVAL_S)


async def settle(
    deps: WorkerDeps, job: jobs.ClaimedJob, code: str, message: str, *, permanent: bool
) -> None:
    try:
        if permanent or job.attempts >= job.max_attempts:
            log.warning("job %s failed (%s): %s", job.job_id, code, message)
            await jobs.fail(deps.pool, job, code, message)
        else:
            delay = RETRY_BASE_SECONDS * 2**job.attempts
            log.warning("job %s will retry in %s s (%s): %s", job.job_id, delay, code, message)
            await jobs.retry_later(deps.pool, job, code, message, delay)
    except jobs.LeaseLost:
        log.warning("job %s: lease lost before the failure could be recorded", job.job_id)


async def handle(deps: WorkerDeps, job: jobs.ClaimedJob) -> None:
    log.info(
        "job %s claimed: document %s, attempt %s/%s",
        job.job_id,
        job.document_id,
        job.attempts,
        job.max_attempts,
    )
    if job.attempts > job.max_attempts:
        # Earlier attempts died without recording a result (OOM kill, crash): a poison pill.
        await settle(
            deps,
            job,
            ATTEMPTS_EXHAUSTED,
            f"Gave up after {job.max_attempts} attempts",
            permanent=True,
        )
        return
    try:
        indexed = await process_job(deps, job)
        log.info(
            "document %s ready: %s pages, %s chunks, %s embedding tokens, $%s",
            job.document_id,
            indexed.page_count,
            len(indexed.chunks),
            indexed.embed_tokens,
            indexed.embed_cost_usd,
        )
    except jobs.LeaseLost as exc:
        log.warning("dropping results: %s", exc)
    except jobs.DocumentChanged as exc:
        await settle(deps, job, DOCUMENT_UNAVAILABLE, str(exc), permanent=True)
    except IngestError as exc:
        await settle(deps, job, exc.code, exc.message, permanent=exc.permanent)
    except Exception as exc:
        log.exception("job %s: unexpected error", job.job_id)
        await settle(deps, job, INGESTION_FAILED, f"{type(exc).__name__}: {exc}", permanent=False)


async def run() -> None:
    settings = get_settings()
    if settings.openai_api_key is None:
        raise SystemExit("OPENAI_API_KEY is required by the ingestion worker")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    pool = create_pool(settings, max_size=POOL_MAX_SIZE)
    await pool.open(wait=False)
    async with (
        httpx.AsyncClient() as http,
        AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value(), max_retries=2) as openai,
    ):
        deps = WorkerDeps(
            pool=pool,
            http=http,
            openai=openai,
            api_url=settings.api_url,
            internal_token=settings.internal_token.get_secret_value(),
        )
        beat = asyncio.create_task(heartbeat(deps, stop))
        log.info("worker %s started (lease %s s)", worker_id, settings.job_lease_seconds)
        try:
            while not stop.is_set():
                try:
                    job = await jobs.claim(pool, worker_id, settings.job_lease_seconds)
                except Exception:
                    log.warning("could not claim a job", exc_info=True)
                    job = None
                if job is not None:
                    await handle(deps, job)
                    continue
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_S)
        finally:
            stop.set()
            await beat
            await pool.close()
            log.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(run())
