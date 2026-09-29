"""One llm_calls row per billed API call, committed immediately in its own transaction.

The database prices the call (BEFORE INSERT trigger) and accrues daily usage (AFTER INSERT), so
writers only report token counts. Keep the insert outside any larger transaction: the money
record must survive whatever happens to the request afterwards.
"""

from decimal import Decimal
from typing import Literal
from uuid import UUID

from psycopg_pool import AsyncConnectionPool

Purpose = Literal["chat", "rewrite", "query_embed", "doc_embed", "judge", "eval"]

INSERT = """
INSERT INTO llm_calls (
    tenant_id, purpose, model, response_model, service_tier, request_id, document_id,
    input_tokens, cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    usage_estimated, latency_ms, ttft_ms
) VALUES (
    %(tenant_id)s, %(purpose)s, %(model)s, %(response_model)s, %(service_tier)s, %(request_id)s,
    %(document_id)s, %(input_tokens)s, %(cached_tokens)s, %(cache_write_tokens)s,
    %(output_tokens)s, %(reasoning_tokens)s, %(usage_estimated)s, %(latency_ms)s, %(ttft_ms)s
)
RETURNING cost_usd
"""


async def record_llm_call(
    pool: AsyncConnectionPool,
    *,
    tenant_id: UUID,
    purpose: Purpose,
    model: str,
    input_tokens: int,
    cached_tokens: int = 0,
    cache_write_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    response_model: str | None = None,
    service_tier: str = "default",
    request_id: UUID | None = None,
    document_id: UUID | None = None,
    usage_estimated: bool = False,
    latency_ms: int | None = None,
    ttft_ms: int | None = None,
) -> Decimal:
    """Returns the cost the database computed for this call."""
    async with pool.connection() as conn, conn.transaction():
        cur = await conn.execute(
            INSERT,
            {
                "tenant_id": tenant_id,
                "purpose": purpose,
                "model": model,
                "response_model": response_model,
                "service_tier": service_tier,
                "request_id": request_id,
                "document_id": document_id,
                "input_tokens": input_tokens,
                "cached_tokens": cached_tokens,
                "cache_write_tokens": cache_write_tokens,
                "output_tokens": output_tokens,
                "reasoning_tokens": reasoning_tokens,
                "usage_estimated": usage_estimated,
                "latency_ms": latency_ms,
                "ttft_ms": ttft_ms,
            },
        )
        row = await cur.fetchone()
    assert row is not None
    cost: Decimal = row[0]
    return cost
