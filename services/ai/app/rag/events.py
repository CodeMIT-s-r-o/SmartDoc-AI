"""Chat SSE events. Must match packages/contracts (tests validate against its JSON Schema)."""

import json
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

DoneStatus = Literal["answered", "no_answer_gate", "no_answer_model", "cached", "degraded"]
ErrorCode = Literal["UPSTREAM_TIMEOUT", "OPENAI_ERROR", "SCOPE_MISMATCH", "INTERNAL"]


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class Meta(_Camel):
    request_id: UUID
    model: str
    prompt_version: str
    cache: Literal["miss", "exact"]
    # The standalone question that drove retrieval, when a follow-up was rewritten. Omitted
    # (never null) otherwise: the contract types it as optional.
    rewritten_question: str | None = None


class Source(_Camel):
    n: int
    chunk_id: UUID
    document_id: UUID
    title: str
    section: str | None
    page_start: int
    page_end: int
    score: float
    snippet: str


class Token(_Camel):
    d: str


class Usage(_Camel):
    input: int = 0
    cached: int = 0
    cache_write: int = 0
    output: int = 0
    reasoning: int = 0
    embedding: int = 0


class LatencyMs(_Camel):
    retrieval: float | None
    ttft: float | None
    total: float


class Done(_Camel):
    status: DoneStatus
    cited_sources: list[int]
    citations_valid: bool
    usage: Usage
    cost_usd: float
    saved_usd: float
    latency_ms: LatencyMs
    abstained: bool
    trace_id: str | None


class Error(_Camel):
    code: ErrorCode
    message: str
    retryable: bool


@dataclass(frozen=True)
class ChatEvent:
    name: Literal["meta", "sources", "token", "done", "error"]
    data: BaseModel | list[Source]

    def payload(self) -> Any:
        if isinstance(self.data, list):
            return [s.model_dump(mode="json", by_alias=True) for s in self.data]
        return self.data.model_dump(
            mode="json", by_alias=True, exclude_none=isinstance(self.data, Meta)
        )

    def json(self) -> str:
        return json.dumps(self.payload(), separators=(",", ":"), ensure_ascii=False)
