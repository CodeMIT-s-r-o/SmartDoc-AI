"""Internal chat and retrieval endpoints (called by NestJS only, behind the internal token)."""

from collections.abc import AsyncIterator
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.api.deps import require_internal_token
from app.db import Pool
from app.rag.chat import ChatPipeline, ChatRequest
from app.rag.config import RagConfig
from app.rag.prompt import HistoryTurn
from app.rag.retrieve import retrieve, verify_scope

router = APIRouter(dependencies=[Depends(require_internal_token)])


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class HistoryTurnBody(_Camel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatBody(_Camel):
    request_id: UUID
    tenant_id: UUID
    conversation_id: UUID | None = None
    question: str = Field(min_length=1, max_length=2000)
    history: list[HistoryTurnBody] = Field(default_factory=list, max_length=20)
    document_ids: list[UUID] = Field(min_length=1, max_length=50)


def get_pipeline(request: Request) -> ChatPipeline:
    pipeline: ChatPipeline = request.app.state.chat_pipeline
    return pipeline


@router.post("/internal/chat", response_class=EventSourceResponse)
async def chat(
    body: ChatBody, pipeline: Annotated[ChatPipeline, Depends(get_pipeline)]
) -> AsyncIterator[ServerSentEvent]:
    """SSE: meta, sources, token..., then done or error. FastAPI pings every 15 s when idle."""
    req = ChatRequest(
        request_id=body.request_id,
        tenant_id=body.tenant_id,
        conversation_id=body.conversation_id,
        question=body.question,
        history=[HistoryTurn(t.role, t.content) for t in body.history],
        document_ids=body.document_ids,
    )
    async for event in pipeline.run(req):
        yield ServerSentEvent(event=event.name, raw_data=event.json())


class RetrieveBody(_Camel):
    tenant_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    document_ids: list[UUID] = Field(min_length=1, max_length=50)
    top_k: int = Field(default=5, ge=1, le=50)
    hybrid_enabled: bool = True


class RetrievedChunk(_Camel):
    chunk_id: UUID
    document_id: UUID
    section: str | None
    page_start: int
    page_end: int
    vector_score: float | None
    fts_rank: float | None
    matched_lexemes: int | None
    rrf_score: float
    content: str


@router.post("/internal/retrieve")
async def retrieve_debug(
    body: RetrieveBody, pool: Pool, pipeline: Annotated[ChatPipeline, Depends(get_pipeline)]
) -> list[RetrievedChunk]:
    """Retrieval only (eval and debugging), with bounded overrides; never used by the UI."""
    config = RagConfig(
        **{
            **pipeline.config.model_dump(),
            "top_k": body.top_k,
            "hybrid_enabled": body.hybrid_enabled,
        }
    )
    vector = None
    if pipeline.client is not None:
        res = await pipeline.client.embeddings.create(
            model=config.embedding_model,
            input=body.question,
            dimensions=config.embedding_dimensions,
        )
        vector = list(res.data[0].embedding)
    async with pool.connection() as conn, conn.transaction():
        await verify_scope(conn, body.tenant_id, body.document_ids)
        result = await retrieve(
            conn,
            tenant=body.tenant_id,
            document_ids=body.document_ids,
            question=body.question,
            query_vector=vector,
            config=config,
        )
    return [
        RetrievedChunk(
            chunk_id=c.chunk_id,
            document_id=c.document_id,
            section=c.section_path,
            page_start=c.page_start,
            page_end=c.page_end,
            vector_score=c.vector_score,
            fts_rank=c.fts_rank,
            matched_lexemes=c.matched_lexemes,
            rrf_score=c.rrf_score,
            content=c.content,
        )
        for c in result.candidates[: body.top_k]
    ]
