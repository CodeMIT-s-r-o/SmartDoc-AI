import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from openai import AsyncOpenAI

from app.api import chat, health
from app.config import get_settings
from app.db import create_pool
from app.rag.breaker import CircuitBreaker
from app.rag.chat import ChatPipeline
from app.rag.config import get_rag_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

POOL_MAX_SIZE = 4


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    rag = get_rag_config()
    pool = create_pool(settings, max_size=POOL_MAX_SIZE)
    await pool.open(wait=False)
    # No key: chat still answers, in degraded mode (retrieved passages only).
    client = (
        AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value(), max_retries=1, timeout=60)
        if settings.openai_api_key
        else None
    )
    app.state.pool = pool
    app.state.chat_pipeline = ChatPipeline(
        pool,
        client,
        CircuitBreaker(rag.breaker_failures, rag.breaker_window_s, rag.breaker_open_s),
        rag,
    )
    try:
        yield
    finally:
        if client is not None:
            await client.close()
        await pool.close()


app = FastAPI(title="SmartDoc AI service", lifespan=lifespan)
app.include_router(health.router)
app.include_router(chat.router)
