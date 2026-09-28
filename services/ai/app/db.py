from typing import Annotated

from fastapi import Depends, Request
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from app.config import Settings


def create_pool(settings: Settings, *, max_size: int) -> AsyncConnectionPool:
    """Create a closed pool. Callers open it without waiting, so startup never blocks on the DB."""
    return AsyncConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=max_size,
        open=False,
        kwargs={"autocommit": True},
        configure=_configure,
    )


async def _configure(conn: AsyncConnection) -> None:
    # Adapts pgvector's vector/halfvec types (the extension exists before any app connects).
    await register_vector_async(conn)


def get_pool(request: Request) -> AsyncConnectionPool:
    pool: AsyncConnectionPool = request.app.state.pool
    return pool


Pool = Annotated[AsyncConnectionPool, Depends(get_pool)]
