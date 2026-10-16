"""Exact answer cache and standalone rewrite, on the real pipeline (Postgres) with a fake OpenAI."""

import uuid
from collections.abc import AsyncIterator
from typing import Any

import jsonschema
import openai
import pytest
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.db import create_pool
from app.rag.chat import ChatPipeline, ChatRequest
from app.rag.prompt import HistoryTurn

from .test_chat_pipeline import (
    DATABASE_URL,
    REQUEST,
    SCHEMA,
    FakeOpenAI,
    fetch,
    of,
    pipeline,
    seed,
    text,
)

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
    p = create_pool(Settings(database_url=DATABASE_URL), max_size=4)
    await p.open(wait=True)
    yield p
    async with p.connection() as conn:
        await conn.execute("DELETE FROM users WHERE email LIKE '%@chat.test'")
    await p.close()


QUESTION = "How many days of annual leave do I get?"
HISTORY = [
    HistoryTurn("user", "How many days of annual leave do I get?"),
    HistoryTurn("assistant", "You get 25 days of annual leave [1]."),
]


def cached_pipeline(pool: AsyncConnectionPool, fake: FakeOpenAI) -> ChatPipeline:
    return pipeline(pool, fake, rewrite_enabled=True, exact_cache_enabled=True)


async def ask(
    p: ChatPipeline,
    tenant: uuid.UUID,
    docs: list[uuid.UUID],
    question: str,
    *,
    history: list[HistoryTurn] | None = None,
    bypass_cache: bool = False,
) -> tuple[uuid.UUID, list[tuple[str, Any]]]:
    request_id = uuid.uuid4()
    req = ChatRequest(request_id, tenant, None, question, history or [], docs, bypass_cache)
    events: list[tuple[str, Any]] = [(e.name, e.payload()) async for e in p.run(req)]
    for name, data in events:
        jsonschema.validate({"event": name, "data": data}, SCHEMA)
    return request_id, events


async def add_document(pool: AsyncConnectionPool, tenant: uuid.UUID) -> uuid.UUID:
    doc = uuid.uuid4()
    async with pool.connection() as conn:
        await conn.execute(
            """INSERT INTO documents (id, tenant_id, title, original_filename, s3_key, size_bytes,
                                      status, ready_at)
               VALUES (%s, %s, 'Travel Policy', 't.pdf', 'k2', 1, 'ready', now())""",
            (doc, tenant),
        )
    return doc


async def test_the_same_question_twice_is_answered_once(pool: AsyncConnectionPool) -> None:
    tenant, doc = await seed(pool)
    fake = FakeOpenAI()
    p = cached_pipeline(pool, fake)

    _, first = await ask(p, tenant, [doc], QUESTION)
    request_id, second = await ask(p, tenant, [doc], "  how many days of ANNUAL leave do I get ")

    assert of(first, "done")["status"] == "answered"
    assert of(second, "meta")["cache"] == "exact"
    assert of(second, "sources") == of(first, "sources")
    assert text(second) == text(first)
    done = of(second, "done")
    original = of(first, "done")["costUsd"]
    assert done["status"] == "cached" and done["citedSources"] == [1]
    assert done["costUsd"] == 0 and done["savedUsd"] == pytest.approx(original)
    # The hit embedded nothing and generated nothing.
    assert fake.embed_calls == 1 and len(fake.chat_calls) == 1

    [saving] = await fetch(
        pool,
        """SELECT mechanism, basis, baseline_usd::float8, actual_usd::float8, saved_usd::float8
             FROM cost_savings WHERE request_id = %s""",
        request_id,
    )
    assert saving == (
        "exact_cache",
        "estimated",
        pytest.approx(original),
        0.0,
        pytest.approx(original),
    )
    [request] = await fetch(
        pool, "SELECT status, cache_type, cost_usd FROM rag_requests WHERE id = %s", request_id
    )
    assert request[:2] == ("cached", "exact") and request[2] == 0
    [entry] = await fetch(
        pool,
        """SELECT hit_count, expires_at > now() + interval '6 days'
             FROM response_cache WHERE tenant_id = %s""",
        tenant,
    )
    assert entry == (1, True)


async def test_a_new_upload_or_a_reingest_is_a_miss(pool: AsyncConnectionPool) -> None:
    tenant, doc = await seed(pool)
    async with pool.connection() as conn:
        await conn.execute("UPDATE documents SET ready_at = now() WHERE id = %s", (doc,))
    fake = FakeOpenAI()
    p = cached_pipeline(pool, fake)
    await ask(p, tenant, [doc], QUESTION)

    new_doc = await add_document(pool, tenant)
    _, with_new_doc = await ask(p, tenant, [doc, new_doc], QUESTION)
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE documents SET ready_at = ready_at + interval '1 minute' WHERE id = %s", (doc,)
        )
    _, after_reingest = await ask(p, tenant, [doc], QUESTION)

    assert of(with_new_doc, "meta")["cache"] == "miss"
    assert of(after_reingest, "meta")["cache"] == "miss"
    assert len(fake.chat_calls) == 3


async def test_caches_only_clean_answers_to_standalone_questions(pool: AsyncConnectionPool) -> None:
    tenant, doc = await seed(pool)
    abstaining = FakeOpenAI(answer="NO_ANSWER The documents do not cover this.")
    p = cached_pipeline(pool, abstaining)
    await ask(p, tenant, [doc], QUESTION)
    _, again = await ask(p, tenant, [doc], QUESTION)
    assert of(again, "meta")["cache"] == "miss"  # abstentions are never cached

    no_rewrite = pipeline(pool, FakeOpenAI(), rewrite_enabled=False, exact_cache_enabled=True)
    await ask(no_rewrite, tenant, [doc], "And how many of them carry over?", history=HISTORY)
    rows = await fetch(pool, "SELECT count(*) FROM response_cache WHERE tenant_id = %s", tenant)
    assert rows == [(0,)]  # a follow-up that was not rewritten has no meaning of its own

    answering = FakeOpenAI()
    p = cached_pipeline(pool, answering)
    await ask(p, tenant, [doc], QUESTION)
    _, bypassed = await ask(p, tenant, [doc], QUESTION, bypass_cache=True)
    assert of(bypassed, "meta")["cache"] == "miss" and len(answering.chat_calls) == 2


async def test_a_follow_up_is_rewritten_for_retrieval_and_the_cache(
    pool: AsyncConnectionPool,
) -> None:
    tenant, doc = await seed(pool)
    standalone = "How many annual leave days can I carry over to next year?"
    fake = FakeOpenAI(rewrite=standalone)
    p = cached_pipeline(pool, fake)

    request_id, events = await ask(
        p, tenant, [doc], "And how many of them can I carry over?", history=HISTORY
    )

    assert of(events, "meta")["rewrittenQuestion"] == standalone
    assert fake.embed_inputs == [standalone]  # retrieval searched for the standalone question
    [rewrite_call] = fake.rewrite_calls
    assert (
        "<user>How many days of annual leave do I get?</user>"
        in rewrite_call["input"][1]["content"]
    )
    # The model still answers the original follow-up, with the conversation as history.
    chat_input = fake.chat_calls[0]["input"]
    assert "And how many of them can I carry over?" in chat_input[-1]["content"][0]["text"]
    purposes = await fetch(
        pool, "SELECT purpose FROM llm_calls WHERE request_id = %s ORDER BY purpose", request_id
    )
    assert [p[0] for p in purposes] == ["chat", "query_embed", "rewrite"]
    [row] = await fetch(pool, "SELECT rewritten FROM rag_requests WHERE id = %s", request_id)
    assert row == (True,)

    # Asked directly later, the standalone question finds the rewritten follow-up's answer.
    _, direct = await ask(p, tenant, [doc], standalone)
    assert of(direct, "meta")["cache"] == "exact"


async def test_a_failed_rewrite_falls_back_to_the_original_question(
    pool: AsyncConnectionPool,
) -> None:
    tenant, doc = await seed(pool)
    fake = FakeOpenAI(rewrite_error=openai.APIConnectionError(request=REQUEST))
    p = cached_pipeline(pool, fake)

    _, events = await ask(p, tenant, [doc], "And how many of them?", history=HISTORY)

    assert "rewrittenQuestion" not in of(events, "meta")
    assert fake.embed_inputs == ["And how many of them?"]
    assert of(events, "done")["status"] == "answered"
    rows = await fetch(pool, "SELECT count(*) FROM response_cache WHERE tenant_id = %s", tenant)
    assert rows == [(0,)]
