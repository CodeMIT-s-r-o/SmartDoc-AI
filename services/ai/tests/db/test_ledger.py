"""The cost ledger against a real, migrated Postgres (make test-db), as the application role.

The price lives in the database: a BEFORE INSERT trigger prices each llm_calls row from the
model_prices row valid at created_at, and an AFTER INSERT trigger accrues it into the daily
budget rows. These tests pin the formula to calls measured live (docs/BUILD_LOG.md).
"""

import os
import uuid
from collections.abc import AsyncIterator
from datetime import date
from decimal import Decimal

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.cost.ledger import record_llm_call
from app.db import create_pool

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def pool() -> AsyncIterator[AsyncConnectionPool]:
    assert DATABASE_URL is not None
    p = create_pool(Settings(database_url=DATABASE_URL), max_size=2)
    await p.open(wait=True)
    yield p
    async with p.connection() as conn:
        await conn.execute("DELETE FROM users WHERE email LIKE '%@ledger.test'")
    await p.close()


@pytest.fixture
async def tenant(pool: AsyncConnectionPool) -> uuid.UUID:
    tenant_id = uuid.uuid4()
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO users (id, email) VALUES (%s, %s)", (tenant_id, f"{tenant_id}@ledger.test")
        )
    return tenant_id


async def insert_at(
    pool: AsyncConnectionPool, tenant_id: uuid.UUID, created_at: str, purpose: str = "chat"
) -> None:
    """A row with an explicit created_at, for price validity and day boundaries."""
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens, output_tokens,
                                      created_at)
               VALUES (%s, %s, 'gpt-6-luna', 1000000, 0, %s)""",
            (tenant_id, purpose, created_at),
        )


@pytest.mark.parametrize(
    ("tokens", "expected"),
    [
        # The warm-cache answer measured in Block 1.7: 326 ordinary + 1,264 cached, 21 output.
        (dict(input_tokens=1590, cached_tokens=1264, output_tokens=21), "0.00005574"),
        # The cold answer measured in Block 1.8: the 1,264-token prefix written to the cache.
        (dict(input_tokens=3396, cache_write_tokens=1264, output_tokens=20), "0.0003812"),
        # Reasoning tokens are part of output_tokens and are never billed twice.
        (dict(input_tokens=0, output_tokens=100, reasoning_tokens=80), "0.00005"),
    ],
)
async def test_prices_a_chat_call_from_its_token_counts(
    pool: AsyncConnectionPool, tenant: uuid.UUID, tokens: dict[str, int], expected: str
) -> None:
    cost = await record_llm_call(
        pool, tenant_id=tenant, purpose="chat", model="gpt-6-luna", **tokens
    )

    assert cost == Decimal(expected)


async def test_flex_costs_half_and_embeddings_have_their_own_price(
    pool: AsyncConnectionPool, tenant: uuid.UUID
) -> None:
    flex = await record_llm_call(
        pool,
        tenant_id=tenant,
        purpose="judge",
        model="gpt-6-luna",
        service_tier="flex",
        input_tokens=3396,
        cache_write_tokens=1264,
        output_tokens=20,
    )
    embedding = await record_llm_call(
        pool,
        tenant_id=tenant,
        purpose="query_embed",
        model="text-embedding-3-small",
        input_tokens=1_000_000,
    )

    assert flex == Decimal("0.0001906")
    assert embedding == Decimal("0.02")


async def test_refuses_a_call_without_a_valid_price(
    pool: AsyncConnectionPool, tenant: uuid.UUID
) -> None:
    with pytest.raises(psycopg.errors.RaiseException, match="no price"):
        await record_llm_call(
            pool, tenant_id=tenant, purpose="chat", model="gpt-unknown", input_tokens=1
        )
    # gpt-6-luna is priced from 2026-09-22: an older call has no valid price row.
    with pytest.raises(psycopg.errors.RaiseException, match="no price"):
        await insert_at(pool, tenant, "2026-09-21T23:59:59Z")


async def test_accrues_spend_per_bratislava_day_and_counts_only_chat_requests(
    pool: AsyncConnectionPool, tenant: uuid.UUID
) -> None:
    # 21:59 UTC is 23:59 in Bratislava (CEST); 22:30 UTC is already the next day there.
    await insert_at(pool, tenant, "2026-09-29T21:59:00Z")
    await insert_at(pool, tenant, "2026-09-29T22:30:00Z")
    await insert_at(pool, tenant, "2026-09-29T23:00:00Z", purpose="query_embed")

    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT day, spent_usd, requests FROM user_daily_usage"
                " WHERE tenant_id = %s ORDER BY day",
                (tenant,),
            )
        ).fetchall()

    # Each row is 1M gpt-6-luna input tokens = $0.10.
    assert rows == [
        (date(2026, 9, 29), Decimal("0.1000000000"), 1),
        (date(2026, 9, 30), Decimal("0.2000000000"), 1),
    ]


async def test_the_ledger_is_append_only_and_prices_are_migration_only(
    pool: AsyncConnectionPool, tenant: uuid.UUID
) -> None:
    await record_llm_call(
        pool, tenant_id=tenant, purpose="chat", model="gpt-6-luna", input_tokens=1
    )

    for statement in (
        "UPDATE llm_calls SET cost_usd = 0 WHERE tenant_id = %s",
        "DELETE FROM llm_calls WHERE tenant_id = %s",
        "UPDATE model_prices SET input_usd_per_mtok = 0 WHERE %s IS NOT NULL",
    ):
        async with pool.connection() as conn:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await conn.execute(statement, (tenant,))
