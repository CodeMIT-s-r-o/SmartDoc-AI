"""Ingestion worker entry point: `python -m app.ingest.worker`.

Block 0 skeleton: proves liveness and database connectivity. Job claiming
(`FOR UPDATE SKIP LOCKED` + lease) lands in Block 1.6, see docs/IMPLEMENTATION_PLAN.md §2.3.
"""

import asyncio
import contextlib
import logging
import os
import signal
from pathlib import Path

from app.config import get_settings
from app.db import create_pool

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("worker")

POLL_INTERVAL_S = 2.0
POOL_MAX_SIZE = 2
HEARTBEAT_FILE = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/worker-heartbeat"))


async def run() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    pool = create_pool(get_settings(), max_size=POOL_MAX_SIZE)
    await pool.open(wait=False)
    log.info("worker started")
    try:
        while not stop.is_set():
            try:
                async with pool.connection(timeout=POLL_INTERVAL_S) as conn:
                    await conn.execute("select 1")
                # The heartbeat only advances while the database is reachable.
                await asyncio.to_thread(HEARTBEAT_FILE.touch)
            except Exception:
                log.warning("database unreachable", exc_info=True)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL_S)
    finally:
        await pool.close()
        log.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(run())
