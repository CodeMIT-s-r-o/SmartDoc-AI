"""The RAG behaviour described in the first LinkedIn post (October 2026), each claim pinned here.

If one of these fails, the code has changed under a published sentence: fix the code, or correct
the post. Runs on the same real-Postgres pipeline and fake OpenAI as test_chat_pipeline.
"""

import uuid
from collections.abc import AsyncIterator
from typing import Any

import openai
import pytest
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.db import create_pool
from app.rag.chat import DEGRADED_TEXT, ChatRequest
from app.rag.prompt import HistoryTurn

# anyio_backend is a fixture, imported by name so pytest picks it up here too.
from .test_chat_pipeline import (  # noqa: F401
    DATABASE_URL,
    REQUEST,
    FakeOpenAI,
    anyio_backend,
    axis,
    fetch,
    of,
    pipeline,
    run,
    seed,
    text,
)

pytestmark = [
    pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set"),
    pytest.mark.anyio,
]


@pytest.fixture
async def pool() -> AsyncIterator[AsyncConnectionPool]:
    # seed() creates its users as <uuid>@chat.test, the same rows test_chat_pipeline cleans up.
    assert DATABASE_URL is not None
    p = create_pool(Settings(database_url=DATABASE_URL), max_size=4)
    await p.open(wait=True)
    yield p
    async with p.connection() as conn:
        await conn.execute("DELETE FROM users WHERE email LIKE '%@chat.test'")
    await p.close()


async def test_weak_retrieval_declines_without_calling_the_chat_model(
    pool: AsyncConnectionPool,
) -> None:
    """ "When retrieval comes back weak, the app declines instead of asking the model to answer.
    Nothing generated, no confident guess."

    The chat model is never called. The query embedding that found nothing relevant has already
    been paid for, though: declining saves the generation, not every token.
    """
    tenant, doc = await seed(pool)
    fake = FakeOpenAI(vector=axis(1000))

    request_id, events = await run(pipeline(pool, fake), tenant, [doc], "zebra quantum spaceship")

    assert of(events, "done")["abstained"]
    assert fake.chat_calls == []
    rows = await fetch(
        pool, "SELECT purpose, cost_usd FROM llm_calls WHERE request_id = %s", request_id
    )
    assert [purpose for purpose, _ in rows] == ["query_embed"]
    assert all(cost > 0 for _, cost in rows)


async def test_with_the_llm_down_it_returns_the_most_relevant_passages(
    pool: AsyncConnectionPool,
) -> None:
    """ "If the LLM is unavailable, the app still returns the most relevant passages." """
    tenant, doc = await seed(pool)
    fake = FakeOpenAI(chat_error=openai.APITimeoutError(request=REQUEST))

    _, events = await run(pipeline(pool, fake), tenant, [doc], "annual leave days")

    assert of(events, "done")["status"] == "degraded"
    assert text(events) == DEGRADED_TEXT
    sources = of(events, "sources")
    assert sources, "a degraded answer must still carry passages"
    assert "25 days of paid annual leave" in sources[0]["snippet"]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Known gap, described in the post (BUILD_LOG 2026-09-29): a follow-up is searched as "
        "typed, without the conversation. When query rewriting lands this starts passing, and "
        "strict=True turns that into a failure, so remove the marker and update the post."
    ),
)
async def test_a_follow_up_is_searched_with_the_question_it_means(
    pool: AsyncConnectionPool,
) -> None:
    """ "'And how many of them can I carry over?' found nothing useful, because search ran on
    the literal follow-up instead of the question it meant." """
    tenant, doc = await seed(pool)
    fake = FakeOpenAI()
    searched: list[str] = []
    embed = fake.embeddings.create

    async def recording_embed(**kwargs: Any) -> Any:
        searched.append(kwargs["input"])
        return await embed(**kwargs)

    fake.embeddings.create = recording_embed  # type: ignore[method-assign]
    req = ChatRequest(
        uuid.uuid4(),
        tenant,
        None,
        "And how many of them can I carry over?",
        [
            HistoryTurn("user", "How many days of annual leave do I get?"),
            HistoryTurn("assistant", "You get 25 days of paid annual leave per year [1]."),
        ],
        [doc],
    )

    _ = [event async for event in pipeline(pool, fake).run(req)]

    assert searched, "the question should have been embedded for search"
    assert "leave" in searched[0].lower(), f"searched for {searched[0]!r} alone"
