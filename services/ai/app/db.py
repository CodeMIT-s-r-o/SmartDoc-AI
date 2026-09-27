from typing import Annotated

from fastapi import Depends, Request
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
    )


def get_pool(request: Request) -> AsyncConnectionPool:
    pool: AsyncConnectionPool = request.app.state.pool
    return pool


Pool = Annotated[AsyncConnectionPool, Depends(get_pool)]
