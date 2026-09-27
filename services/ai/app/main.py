import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import health
from app.config import get_settings
from app.db import create_pool

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

POOL_MAX_SIZE = 4


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    pool = create_pool(get_settings(), max_size=POOL_MAX_SIZE)
    await pool.open(wait=False)
    app.state.pool = pool
    try:
        yield
    finally:
        await pool.close()


app = FastAPI(title="SmartDoc AI service", lifespan=lifespan)
app.include_router(health.router)
