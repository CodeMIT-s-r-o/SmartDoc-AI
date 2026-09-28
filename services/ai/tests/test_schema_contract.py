"""Schema contract: NestJS/Drizzle owns the schema, Python depends on it. Guards against drift.

Runs against a migrated database as the application role (the role the services use):
    make test-db
Skipped when TEST_DATABASE_URL is not set, so the default `make test` needs no database.
Every test runs in a transaction that is rolled back.
"""

import os
import uuid
from collections.abc import Iterator
from decimal import Decimal

import psycopg
import pytest

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")

# Columns (name -> formatted type) the Python services read or write. Extra columns are fine.
EXPECTED_COLUMNS: dict[str, dict[str, str]] = {
    "documents": {
        "id": "uuid",
        "tenant_id": "uuid",
        "title": "text",
        "s3_key": "text",
        "s3_version_id": "text",
        "status": "text",
        "error_code": "text",
        "page_count": "integer",
        "chunk_count": "integer",
        "embed_tokens": "integer",
        "embed_cost_usd": "numeric(14,10)",
        "ready_at": "timestamp with time zone",
    },
    "ingestion_jobs": {
        "id": "uuid",
        "document_id": "uuid",
        "status": "text",
        "stage": "text",
        "attempts": "integer",
        "max_attempts": "integer",
        "run_after": "timestamp with time zone",
        "locked_at": "timestamp with time zone",
        "locked_by": "text",
        "lease_token": "uuid",
        "error_code": "text",
        "last_error": "text",
    },
    "chunks": {
        "id": "uuid",
        "document_id": "uuid",
        "tenant_id": "uuid",
        "chunk_index": "integer",
        "content": "text",
        "section_path": "text",
        "page_start": "integer",
        "page_end": "integer",
        "char_start": "integer",
        "token_count": "integer",
        "content_hash": "text",
        "embedding_model": "text",
        "embedding": "halfvec(1536)",
        "tsv": "tsvector",
        "injection_score": "real",
        "injection_flags": "text[]",
    },
    "rag_requests": {
        "id": "uuid",
        "tenant_id": "uuid",
        "config": "jsonb",
        "config_hash": "text",
        "status": "text",
        "max_cos": "real",
        "cost_usd": "numeric(14,10)",
    },
    "retrievals": {
        "request_id": "uuid",
        "rank": "integer",
        "chunk_id": "uuid",
        "vector_score": "real",
        "fts_rank": "real",
        "rrf_score": "real",
    },
    "llm_calls": {
        "request_id": "uuid",
        "document_id": "uuid",
        "tenant_id": "uuid",
        "purpose": "text",
        "model": "text",
        "service_tier": "text",
        "input_tokens": "integer",
        "cached_tokens": "integer",
        "cache_write_tokens": "integer",
        "output_tokens": "integer",
        "reasoning_tokens": "integer",
        "cost_usd": "numeric(14,10)",
        "usage_estimated": "boolean",
    },
}

# DML the application role must have; everything else in public gets full DML.
RESTRICTED_GRANTS = {
    "model_prices": {"SELECT"},
    "llm_calls": {"SELECT", "INSERT"},
}
FULL_DML = {"SELECT", "INSERT", "UPDATE", "DELETE"}


@pytest.fixture
def conn() -> Iterator[psycopg.Connection]:
    assert DATABASE_URL is not None
    with psycopg.connect(DATABASE_URL) as connection:
        yield connection
        connection.rollback()


def columns(conn: psycopg.Connection, table: str) -> dict[str, str]:
    rows = conn.execute(
        """
        SELECT a.attname, format_type(a.atttypid, a.atttypmod)
          FROM pg_attribute a
         WHERE a.attrelid = %s::regclass AND a.attnum > 0 AND NOT a.attisdropped
        """,
        (f"public.{table}",),
    ).fetchall()
    return {name: type_ for name, type_ in rows}


@pytest.mark.parametrize("table", sorted(EXPECTED_COLUMNS))
def test_columns_python_depends_on(conn: psycopg.Connection, table: str) -> None:
    actual = columns(conn, table)
    for name, type_ in EXPECTED_COLUMNS[table].items():
        assert actual.get(name) == type_, (
            f"{table}.{name}: expected {type_}, got {actual.get(name)}"
        )


def test_search_indexes(conn: psycopg.Connection) -> None:
    defs = [
        row[0] for row in conn.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks'")
    ]
    assert any("USING hnsw (embedding halfvec_cosine_ops)" in d for d in defs), defs
    assert any("USING gin (tsv)" in d for d in defs), defs


def test_application_role_privileges(conn: psycopg.Connection) -> None:
    grants: dict[str, set[str]] = {}
    for table, privilege in conn.execute(
        """
        SELECT table_name, privilege_type
          FROM information_schema.role_table_grants
         WHERE grantee = current_user AND table_schema = 'public'
        """
    ):
        grants.setdefault(table, set()).add(privilege)
    tables = [
        row[0]
        for row in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    ]

    assert tables, "no tables: is the database migrated?"
    for table in tables:
        expected = RESTRICTED_GRANTS.get(table, FULL_DML)
        assert grants.get(table, set()) == expected, f"{table}: {grants.get(table)}"

    can_create = conn.execute("SELECT has_schema_privilege('public', 'CREATE')").fetchone()
    assert can_create == (False,)


def insert_user(conn: psycopg.Connection) -> uuid.UUID:
    tenant = uuid.uuid4()
    conn.execute(
        "INSERT INTO users (id, email) VALUES (%s, %s)", (tenant, f"{tenant}@contract.test")
    )
    return tenant


def test_ledger_prices_calls_and_accrues_daily_usage(conn: psycopg.Connection) -> None:
    tenant = insert_user(conn)

    # A warm chat call: 3,050 input tokens (1,024 read from the prompt cache), 300 output tokens.
    chat_cost = conn.execute(
        """
        INSERT INTO llm_calls
            (tenant_id, purpose, model, input_tokens, cached_tokens, output_tokens)
        VALUES (%s, 'chat', 'gpt-6-luna', 3050, 1024, 300)
        RETURNING cost_usd
        """,
        (tenant,),
    ).fetchone()
    # (2026*0.10 + 1024*0.01 + 300*0.50) / 1e6
    assert chat_cost == (Decimal("0.0003628400"),)

    embed_cost = conn.execute(
        """
        INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens)
        VALUES (%s, 'query_embed', 'text-embedding-3-small', 12)
        RETURNING cost_usd
        """,
        (tenant,),
    ).fetchone()
    assert embed_cost == (Decimal("0.0000002400"),)

    usage = conn.execute(
        "SELECT spent_usd, requests FROM user_daily_usage WHERE tenant_id = %s", (tenant,)
    ).fetchall()
    # Both calls accrue spend; only the chat call counts as a request.
    assert usage == [(Decimal("0.0003630800"), 1)]

    app_spent = conn.execute(
        """
        SELECT spent_usd FROM app_daily_usage
         WHERE day = (now() AT TIME ZONE 'Europe/Bratislava')::date
        """
    ).fetchone()
    assert app_spent is not None and app_spent[0] >= Decimal("0.0003630800")


def test_cache_writes_are_priced_at_the_write_rate(conn: psycopg.Connection) -> None:
    tenant = insert_user(conn)
    cost = conn.execute(
        """
        INSERT INTO llm_calls
            (tenant_id, purpose, model, input_tokens, cache_write_tokens, output_tokens)
        VALUES (%s, 'chat', 'gpt-6-luna', 3050, 1024, 300)
        RETURNING cost_usd
        """,
        (tenant,),
    ).fetchone()
    # (2026*0.10 + 1024*0.125 + 300*0.50) / 1e6
    assert cost == (Decimal("0.0004806000"),)


def test_unknown_model_is_rejected_loudly(conn: psycopg.Connection) -> None:
    tenant = insert_user(conn)
    with pytest.raises(psycopg.errors.RaiseException, match="no price for model"):
        conn.execute(
            "INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens)"
            " VALUES (%s, 'chat', 'gpt-unknown', 10)",
            (tenant,),
        )


def test_cached_tokens_cannot_exceed_input(conn: psycopg.Connection) -> None:
    tenant = insert_user(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens, cached_tokens)"
            " VALUES (%s, 'chat', 'gpt-6-luna', 100, 101)",
            (tenant,),
        )


def test_ledger_is_append_only(conn: psycopg.Connection) -> None:
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("UPDATE llm_calls SET cost_usd = 0")
