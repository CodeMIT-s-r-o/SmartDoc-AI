from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi.testclient import TestClient

from app.db import get_pool
from app.main import app


class FakeConnection:
    def __init__(self, fail: bool) -> None:
        self.fail = fail

    async def execute(self, query: str) -> None:
        if self.fail:
            raise OSError("connection refused")


class FakePool:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    @asynccontextmanager
    # Mirrors psycopg_pool.AsyncConnectionPool.connection(timeout=...).
    async def connection(
        self,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> AsyncIterator[FakeConnection]:
        yield FakeConnection(self.fail)


def client_with(pool: Any) -> TestClient:
    app.dependency_overrides[get_pool] = lambda: pool
    # No context manager: the lifespan (real pool) does not run in unit tests.
    return TestClient(app)


def teardown_function() -> None:
    app.dependency_overrides.clear()


def test_health_ok_when_db_reachable() -> None:
    res = client_with(FakePool()).get("/internal/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "db": "up", "version": "test"}


def test_health_503_when_db_unreachable() -> None:
    res = client_with(FakePool(fail=True)).get("/internal/health")
    assert res.status_code == 503
    assert res.json() == {"detail": {"status": "error", "db": "down"}}
