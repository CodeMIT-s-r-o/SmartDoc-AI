"""One chat turn: scope -> rewrite -> cache -> embed -> retrieval -> gate -> generate -> ledger.

Emits SSE events in contract order: meta, sources, token..., then exactly one of done / error.
Failure policy (docs/planning/IMPLEMENTATION_PLAN.md §2.3, §6):
- OpenAI unreachable before the first token, or the breaker is open: a *degraded* answer that
  shows the retrieved passages (keyword search still works without embeddings), at $0.
- OpenAI fails mid-stream: an `error` event (retryable).
- The client disconnects: the stream to OpenAI is closed and the call is recorded with estimated
  usage. Telemetry is written even then (shielded from cancellation).
Cost: a follow-up is rewritten into a standalone question (one small call) so retrieval and the
exact cache see what is really asked; a cache hit replays the stored answer without embedding or
generating anything.
"""

import asyncio
import hashlib
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import anyio
import openai
from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.cost.ledger import record_llm_call
from app.rag import cache
from app.rag import events as ev
from app.rag.breaker import CircuitBreaker
from app.rag.citations import CitationReport, parse_citations
from app.rag.config import RagConfig
from app.rag.context import ContextChunk, assemble, snippet
from app.rag.history import trim_history
from app.rag.prompt import (
    NO_ANSWER,
    PROMPT_VERSION,
    STATIC_PREFIX,
    HistoryTurn,
    build_input,
    prompt_cache_options,
)
from app.rag.retrieve import Retrieval, ScopeMismatch, gate_fires, retrieve, verify_scope
from app.rag.rewrite import build_rewrite_input, clean_rewrite
from app.rag.tokens import count_tokens

log = logging.getLogger("chat")

# The question embedding is on the user's critical path: fail fast (no retry, short connect),
# degrade to keyword retrieval, and let the breaker stop calling during an outage.
EMBED_TIMEOUT = openai.Timeout(5.0, connect=2.0)
CHAT_TIMEOUT = openai.Timeout(60.0, connect=2.0)
# The rewrite is also on the critical path, and optional: give up quickly and use the original.
REWRITE_TIMEOUT = openai.Timeout(5.0, connect=2.0)
FIRST_TOKEN_TIMEOUT_S = 20.0
# Held back until we know whether the answer starts with the NO_ANSWER sentinel.
SENTINEL_HOLDBACK_CHARS = 12

GATE_TEXT = (
    "I could not find anything about this in your documents. Try rephrasing the question, or "
    "check that the right documents are selected."
)
NO_ANSWER_PREFIX = "I could not find this in your documents."
DEGRADED_TEXT = (
    "The AI answer is temporarily unavailable. The passages above are the closest matches in "
    "your documents."
)
DEGRADED_NO_SOURCES_TEXT = "The AI answer is temporarily unavailable. Please try again shortly."

# Failures that say "OpenAI is unhealthy right now": they count towards the breaker.
TRANSIENT = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.InternalServerError,
    openai.RateLimitError,
    TimeoutError,
)


@dataclass(frozen=True)
class ChatRequest:
    request_id: UUID
    tenant_id: UUID
    conversation_id: UUID | None
    question: str
    history: list[HistoryTurn]
    document_ids: list[UUID]
    bypass_cache: bool = False


class _MidStreamFailure(Exception):
    pass


class _StreamFailed(Exception):
    """OpenAI reported `response.failed` or an `error` event inside the stream."""


@dataclass
class _Run:
    """Everything that ends up in rag_requests / retrievals, collected along the way."""

    started: float = field(default_factory=time.perf_counter)
    status: str = "error"
    retrieval: Retrieval | None = None
    context: list[ContextChunk] = field(default_factory=list)
    citations: CitationReport | None = None
    usage: ev.Usage = field(default_factory=ev.Usage)
    cost: Decimal = Decimal(0)
    response_model: str | None = None
    service_tier: str | None = None
    retrieval_ms: int | None = None
    ttft_ms: int | None = None
    llm_ms: int | None = None
    usage_estimated: bool = False
    rewritten: bool = False
    # Set when the result may be cached: (scope_hash, question_norm_hash) and the scope's documents.
    cache_key: tuple[str, str] | None = None
    scope: dict[UUID, datetime | None] = field(default_factory=dict)
    answer: str = ""
    sources: list[ev.Source] = field(default_factory=list)
    cache_baseline: Decimal | None = None

    def elapsed_ms(self) -> int:
        return round((time.perf_counter() - self.started) * 1000)


def _usage_counts(usage: Any) -> dict[str, int]:
    """OpenAI's usage payload, including fields the SDK may not model yet (cache_write_tokens)."""
    data: dict[str, Any] = usage.model_dump() if usage is not None else {}
    details = data.get("input_tokens_details") or {}
    out_details = data.get("output_tokens_details") or {}
    return {
        "input_tokens": int(data.get("input_tokens") or 0),
        "cached_tokens": int(details.get("cached_tokens") or 0),
        "cache_write_tokens": int(details.get("cache_write_tokens") or 0),
        "output_tokens": int(data.get("output_tokens") or 0),
        "reasoning_tokens": int(out_details.get("reasoning_tokens") or 0),
    }


class ChatPipeline:
    def __init__(
        self,
        pool: AsyncConnectionPool,
        client: AsyncOpenAI | None,
        breaker: CircuitBreaker,
        config: RagConfig,
    ) -> None:
        self.pool = pool
        self.client = client
        self.breaker = breaker
        self.config = config

    # --- public ------------------------------------------------------------------------------

    async def run(self, req: ChatRequest) -> AsyncIterator[ev.ChatEvent]:
        run = _Run()
        try:
            run.scope = await self._verify_scope(req)
            rewritten = await self._rewrite(req, run)
            question = rewritten or req.question
            run.rewritten = rewritten is not None
            # Only a standalone question has a meaning of its own that an answer can be keyed on.
            standalone = not req.history or run.rewritten
            if self.config.exact_cache_enabled and not req.bypass_cache and standalone:
                run.cache_key = (
                    cache.scope_hash(self.config.config_hash(), PROMPT_VERSION, run.scope),
                    cache.question_hash(question),
                )
            hit = await self._lookup(req, run)
            if hit is not None:
                async for event in self._serve_cached(req, run, hit, rewritten):
                    yield event
                return

            yield ev.ChatEvent(
                "meta",
                ev.Meta(
                    request_id=req.request_id,
                    model=self.config.chat_model,
                    prompt_version=PROMPT_VERSION,
                    cache="miss",
                    rewritten_question=rewritten,
                ),
            )
            query_vector = await self._embed_question(req, run, question)

            async with self.pool.connection() as conn, conn.transaction():
                await verify_scope(conn, req.tenant_id, req.document_ids)
                retrieval = await retrieve(
                    conn,
                    tenant=req.tenant_id,
                    document_ids=req.document_ids,
                    question=question,
                    query_vector=query_vector,
                    config=self.config,
                )
            run.retrieval = retrieval
            run.retrieval_ms = run.elapsed_ms()

            if query_vector is not None and gate_fires(retrieval, self.config):
                run.status = "no_answer_gate"
                yield ev.ChatEvent("sources", [])
                yield self._token(GATE_TEXT)
                yield self._done(run)
                return

            run.context = assemble(retrieval.candidates, self.config)
            run.sources = self._sources(run.context)
            yield ev.ChatEvent("sources", run.sources)

            if query_vector is None or not self.breaker.allow() or self.client is None:
                run.status = "degraded"
                yield self._token(DEGRADED_TEXT if run.context else DEGRADED_NO_SOURCES_TEXT)
                yield self._done(run)
                return

            async for event in self._generate(req, run):
                yield event
        except ScopeMismatch as exc:
            log.error("request %s: scope mismatch: %s", req.request_id, exc)
            yield ev.ChatEvent(
                "error",
                ev.Error(
                    code="SCOPE_MISMATCH",
                    message="Some of the selected documents are not available.",
                    retryable=False,
                ),
            )
        except _MidStreamFailure:
            yield ev.ChatEvent(
                "error",
                ev.Error(
                    code="OPENAI_ERROR", message="The answer was interrupted.", retryable=True
                ),
            )
        except (asyncio.CancelledError, GeneratorExit):
            run.status = "aborted"
            raise
        except Exception:
            log.exception("request %s failed", req.request_id)
            run.status = "error"
            yield ev.ChatEvent(
                "error",
                ev.Error(code="INTERNAL", message="Something went wrong.", retryable=True),
            )
        finally:
            with anyio.CancelScope(shield=True):
                await self._persist(req, run)

    # --- steps -------------------------------------------------------------------------------

    async def _verify_scope(self, req: ChatRequest) -> dict[UUID, datetime | None]:
        """Before anything is spent: the documents must be the tenant's and ready."""
        async with self.pool.connection() as conn, conn.transaction():
            return await verify_scope(conn, req.tenant_id, req.document_ids)

    async def _rewrite(self, req: ChatRequest, run: _Run) -> str | None:
        """A standalone version of a follow-up, or None (first turn, disabled, or it failed)."""
        if not (self.config.rewrite_enabled and req.history and self.client is not None):
            return None
        if not self.breaker.allow():
            return None
        history = trim_history(
            req.history, self.config.history_turns, self.config.history_token_budget
        )
        if not history:
            return None
        started = time.perf_counter()
        try:
            res = await self.client.with_options(
                max_retries=0, timeout=REWRITE_TIMEOUT
            ).responses.create(  # type: ignore[call-overload]
                model=self.config.chat_model,
                input=build_rewrite_input(history, req.question),
                reasoning={"effort": "none"},
                text={"verbosity": "low"},
                max_output_tokens=self.config.rewrite_max_output_tokens,
                store=False,
                safety_identifier=hashlib.sha256(str(req.tenant_id).encode()).hexdigest()[:32],
            )
        except (*TRANSIENT, openai.APIError) as exc:
            if isinstance(exc, TRANSIENT):
                self.breaker.record_failure()
            log.warning("request %s: rewrite failed (%s)", req.request_id, type(exc).__name__)
            return None
        self.breaker.record_success()
        counts = _usage_counts(res.usage)
        run.cost += await record_llm_call(
            self.pool,
            tenant_id=req.tenant_id,
            purpose="rewrite",
            model=self.config.chat_model,
            response_model=res.model,
            service_tier=res.service_tier or "default",
            request_id=req.request_id,
            latency_ms=round((time.perf_counter() - started) * 1000),
            input_tokens=counts["input_tokens"],
            cached_tokens=counts["cached_tokens"],
            cache_write_tokens=counts["cache_write_tokens"],
            output_tokens=counts["output_tokens"],
            reasoning_tokens=counts["reasoning_tokens"],
        )
        return clean_rewrite(getattr(res, "output_text", None))

    async def _lookup(self, req: ChatRequest, run: _Run) -> cache.CachedAnswer | None:
        if run.cache_key is None:
            return None
        scope, question = run.cache_key
        async with self.pool.connection() as conn:
            return await cache.lookup(conn, req.tenant_id, scope, question)

    async def _serve_cached(
        self, req: ChatRequest, run: _Run, hit: cache.CachedAnswer, rewritten: str | None
    ) -> AsyncIterator[ev.ChatEvent]:
        """The stored answer, as one token: no embedding, no retrieval, no generation."""
        run.status = "cached"
        run.cache_baseline = hit.original_cost_usd
        run.answer = hit.answer
        run.sources = hit.sources
        run.citations = parse_citations(hit.answer, len(hit.sources))
        yield ev.ChatEvent(
            "meta",
            ev.Meta(
                request_id=req.request_id,
                model=self.config.chat_model,
                prompt_version=PROMPT_VERSION,
                cache="exact",
                rewritten_question=rewritten,
            ),
        )
        yield ev.ChatEvent("sources", hit.sources)
        yield self._token(hit.answer)
        yield self._done(run)

    async def _embed_question(
        self, req: ChatRequest, run: _Run, question: str
    ) -> list[float] | None:
        """None means "no embeddings right now": retrieval falls back to keyword search."""
        if self.client is None or not self.breaker.allow():
            return None
        started = time.perf_counter()
        try:
            res = await self.client.with_options(
                max_retries=0, timeout=EMBED_TIMEOUT
            ).embeddings.create(
                model=self.config.embedding_model,
                input=question,
                dimensions=self.config.embedding_dimensions,
            )
        except TRANSIENT as exc:
            self.breaker.record_failure()
            log.warning(
                "request %s: embeddings unavailable (%s)", req.request_id, type(exc).__name__
            )
            return None
        self.breaker.record_success()
        tokens = res.usage.prompt_tokens
        run.usage = run.usage.model_copy(update={"embedding": tokens})
        run.cost += await record_llm_call(
            self.pool,
            tenant_id=req.tenant_id,
            purpose="query_embed",
            model=self.config.embedding_model,
            input_tokens=tokens,
            request_id=req.request_id,
            latency_ms=round((time.perf_counter() - started) * 1000),
        )
        return list(res.data[0].embedding)

    async def _generate(self, req: ChatRequest, run: _Run) -> AsyncIterator[ev.ChatEvent]:
        assert self.client is not None
        history = trim_history(
            req.history, self.config.history_turns, self.config.history_token_budget
        )
        items = build_input(
            [c.prompt_document() for c in run.context],
            req.question,
            history,
            self.config.prompt_cache_mode,
        )
        started = time.perf_counter()
        try:
            # Plain dicts for input/options; the SDK's overloads only accept its TypedDicts.
            stream = await self.client.with_options(
                timeout=CHAT_TIMEOUT
            ).responses.create(  # type: ignore[call-overload]
                model=self.config.chat_model,
                input=items,
                reasoning={"effort": self.config.reasoning_effort},
                text={"verbosity": self.config.verbosity},
                max_output_tokens=self.config.max_output_tokens,
                store=False,
                stream=True,
                safety_identifier=hashlib.sha256(str(req.tenant_id).encode()).hexdigest()[:32],
                prompt_cache_options=prompt_cache_options(self.config.prompt_cache_mode),
            )
        except TRANSIENT as exc:
            self.breaker.record_failure()
            log.warning("request %s: chat unavailable (%s)", req.request_id, type(exc).__name__)
            run.status = "degraded"
            yield self._token(DEGRADED_TEXT)
            yield self._done(run)
            return

        streamed: list[str] = []
        pending = ""
        abstain: bool | None = None
        completed: Any = None
        try:
            iterator = stream.__aiter__()
            deadline = started + FIRST_TOKEN_TIMEOUT_S
            while True:
                try:
                    if run.ttft_ms is None:
                        remaining = max(deadline - time.perf_counter(), 0.001)
                        event = await asyncio.wait_for(iterator.__anext__(), remaining)
                    else:
                        event = await iterator.__anext__()
                except StopAsyncIteration:
                    break
                if event.type == "response.output_text.delta":
                    if run.ttft_ms is None:
                        run.ttft_ms = run.elapsed_ms()
                    streamed.append(event.delta)
                    if abstain is None:
                        pending += event.delta
                        if len(pending.lstrip()) >= SENTINEL_HOLDBACK_CHARS:
                            abstain = pending.lstrip().startswith(NO_ANSWER)
                            if not abstain:
                                yield self._token(pending)
                    elif not abstain:
                        yield self._token(event.delta)
                elif event.type in ("response.completed", "response.incomplete"):
                    completed = event.response
                elif event.type in ("response.failed", "error"):
                    raise _StreamFailed(event.type)
        except (*TRANSIENT, openai.APIError, _StreamFailed) as exc:
            self.breaker.record_failure()
            if run.ttft_ms is None:
                log.warning("request %s: no first token (%s)", req.request_id, type(exc).__name__)
                run.status = "degraded"
                yield self._token(DEGRADED_TEXT)
                yield self._done(run)
                return
            log.warning("request %s: stream broke (%s)", req.request_id, type(exc).__name__)
            raise _MidStreamFailure from exc
        finally:
            with anyio.CancelScope(shield=True):
                await stream.close()
                if completed is None and streamed:
                    await self._record_estimated(req, run, items, "".join(streamed), started)

        run.llm_ms = round((time.perf_counter() - started) * 1000)
        self.breaker.record_success()
        answer = "".join(streamed)
        if abstain is None:
            abstain = pending.lstrip().startswith(NO_ANSWER)
            if not abstain and pending:
                yield self._token(pending)
        if abstain:
            reason = answer.lstrip()[len(NO_ANSWER) :].strip()
            yield self._token(f"{NO_ANSWER_PREFIX} {reason}".strip())
            run.status = "no_answer_model"
        else:
            run.status = "answered"
            run.answer = answer
            run.citations = parse_citations(answer, len(run.context))

        if completed is not None:
            await self._record_chat(req, run, completed, started)
        yield self._done(run)

    # --- ledger + telemetry ------------------------------------------------------------------

    async def _record_chat(
        self, req: ChatRequest, run: _Run, response: Any, started: float
    ) -> None:
        counts = _usage_counts(response.usage)
        run.response_model = response.model
        run.service_tier = response.service_tier
        run.usage = run.usage.model_copy(
            update={
                "input": counts["input_tokens"],
                "cached": counts["cached_tokens"],
                "cache_write": counts["cache_write_tokens"],
                "output": counts["output_tokens"],
                "reasoning": counts["reasoning_tokens"],
            }
        )
        run.cost += await record_llm_call(
            self.pool,
            tenant_id=req.tenant_id,
            purpose="chat",
            model=self.config.chat_model,
            response_model=response.model,
            service_tier=response.service_tier or "default",
            request_id=req.request_id,
            latency_ms=round((time.perf_counter() - started) * 1000),
            ttft_ms=run.ttft_ms,
            input_tokens=counts["input_tokens"],
            cached_tokens=counts["cached_tokens"],
            cache_write_tokens=counts["cache_write_tokens"],
            output_tokens=counts["output_tokens"],
            reasoning_tokens=counts["reasoning_tokens"],
        )

    async def _record_estimated(
        self,
        req: ChatRequest,
        run: _Run,
        items: list[dict[str, Any]],
        streamed: str,
        started: float,
    ) -> None:
        """The stream ended without usage (client gone, broken stream): bill an estimate."""
        prompt_text = STATIC_PREFIX + "".join(str(item.get("content", "")) for item in items[1:])
        run.usage_estimated = True
        try:
            run.cost += await record_llm_call(
                self.pool,
                tenant_id=req.tenant_id,
                purpose="chat",
                model=self.config.chat_model,
                request_id=req.request_id,
                input_tokens=count_tokens(prompt_text),
                output_tokens=count_tokens(streamed),
                usage_estimated=True,
                latency_ms=round((time.perf_counter() - started) * 1000),
                ttft_ms=run.ttft_ms,
            )
        except Exception:
            log.exception("request %s: could not record estimated usage", req.request_id)

    async def _persist(self, req: ChatRequest, run: _Run) -> None:
        r = run.retrieval
        cited = set(run.citations.cited if run.citations else [])
        context_ids = {c.candidate.chunk_id: c.n for c in run.context}
        try:
            async with self.pool.connection() as conn, conn.transaction():
                cur = await conn.execute(
                    """INSERT INTO rag_requests (
                           id, tenant_id, conversation_id, config, config_hash, prompt_version,
                           model, response_model, service_tier, status, cache_type, rewritten,
                           max_cos, max_matched_lexemes, fts_nonempty, n_chunks, n_citations,
                           citation_coverage, citations_valid, total_ms, retrieval_ms, ttft_ms,
                           llm_ms, cost_usd, usage_estimated)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (id) DO NOTHING""",
                    (
                        req.request_id,
                        req.tenant_id,
                        req.conversation_id,
                        self.config.model_dump_json(),
                        self.config.config_hash(),
                        PROMPT_VERSION,
                        self.config.chat_model,
                        run.response_model,
                        run.service_tier,
                        run.status,
                        "exact" if run.status == "cached" else "miss",
                        run.rewritten,
                        r.max_cos if r else None,
                        r.max_matched_lexemes if r else None,
                        r.fts_nonempty if r else None,
                        len(run.context) or len(run.sources),
                        len(cited),
                        run.citations.coverage if run.citations else None,
                        run.citations.valid if run.citations else None,
                        run.elapsed_ms(),
                        run.retrieval_ms,
                        run.ttft_ms,
                        run.llm_ms,
                        run.cost,
                        run.usage_estimated,
                    ),
                )
                if cur.rowcount == 1 and r is not None:
                    async with conn.cursor() as batch:
                        await batch.executemany(
                            """INSERT INTO retrievals (request_id, rank, chunk_id, document_id,
                                   vector_score, fts_rank, matched_lexemes, rrf_score, cited)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            [
                                (
                                    req.request_id,
                                    rank,
                                    c.chunk_id,
                                    c.document_id,
                                    c.vector_score,
                                    c.fts_rank,
                                    c.matched_lexemes,
                                    c.rrf_score,
                                    context_ids.get(c.chunk_id) in cited,
                                )
                                for rank, c in enumerate(r.candidates, start=1)
                            ],
                        )
                if cur.rowcount == 1:
                    await self._persist_cache(conn, req, run)
        except Exception:
            log.exception("request %s: could not persist telemetry", req.request_id)

    async def _persist_cache(self, conn: Any, req: ChatRequest, run: _Run) -> None:
        """A hit books its saving; a clean, standalone answer is stored for the next asker."""
        if run.status == "cached" and run.cache_baseline is not None:
            await cache.record_saving(
                conn, req.request_id, "exact_cache", run.cache_baseline, run.cost
            )
            return
        report = run.citations
        if (
            run.status == "answered"
            and run.cache_key is not None
            and not run.usage_estimated
            and report is not None
            and report.valid
        ):
            await cache.store(
                conn,
                tenant=req.tenant_id,
                scope=run.cache_key[0],
                question=run.cache_key[1],
                documents=list(run.scope),
                answer=run.answer,
                sources=run.sources,
                cited_sources=report.cited,
                cost_usd=run.cost,
                ttl_days=self.config.cache_ttl_days,
            )

    # --- event helpers -----------------------------------------------------------------------

    @staticmethod
    def _token(text: str) -> ev.ChatEvent:
        return ev.ChatEvent("token", ev.Token(d=text))

    @staticmethod
    def _sources(context: list[ContextChunk]) -> list[ev.Source]:
        return [
            ev.Source(
                n=c.n,
                chunk_id=c.candidate.chunk_id,
                document_id=c.candidate.document_id,
                title=c.candidate.title,
                section=c.candidate.section_path,
                page_start=c.candidate.page_start,
                page_end=c.candidate.page_end,
                score=round(c.candidate.vector_score or 0.0, 4),
                snippet=snippet(c.candidate.content),
            )
            for c in context
        ]

    def _done(self, run: _Run) -> ev.ChatEvent:
        return ev.ChatEvent(
            "done",
            ev.Done(
                status=run.status,  # type: ignore[arg-type]
                cited_sources=run.citations.cited if run.citations else [],
                citations_valid=run.citations.valid if run.citations else True,
                usage=run.usage,
                cost_usd=float(run.cost),
                saved_usd=float(max(run.cache_baseline - run.cost, Decimal(0)))
                if run.cache_baseline is not None
                else 0.0,
                latency_ms=ev.LatencyMs(
                    retrieval=run.retrieval_ms, ttft=run.ttft_ms, total=run.elapsed_ms()
                ),
                abstained=run.status in ("no_answer_gate", "no_answer_model"),
                trace_id=None,
            ),
        )
