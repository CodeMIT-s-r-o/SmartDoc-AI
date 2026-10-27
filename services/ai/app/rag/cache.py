"""Exact answer cache: the same question over the same documents is answered once.

Key = (tenant_id, scope_hash, question_norm_hash). The scope covers everything an answer depends
on besides the question: the RAG config hash (model, effort, retrieval settings), the prompt
version, and every document as id:ready_at. A re-ingest moves ready_at and a new upload changes
the default scope, so both are misses by construction; nothing has to be invalidated.
Only standalone questions are cached (first turn, or a rewritten follow-up), only `answered`
results, and entries expire after `cache_ttl_days`.
"""

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from psycopg import AsyncConnection

from app.rag import events as ev

_SPACES = re.compile(r"\s+")
_TRAILING = re.compile(r"[\s?!.]+$")


def normalize_question(question: str) -> str:
    """Case, Unicode form, spacing and trailing punctuation do not make a different question."""
    text = unicodedata.normalize("NFKC", question).casefold()
    return _TRAILING.sub("", _SPACES.sub(" ", text).strip())


def question_hash(question: str) -> str:
    return hashlib.sha256(normalize_question(question).encode()).hexdigest()


def scope_hash(
    config_hash: str, prompt_version: str, documents: Mapping[UUID, datetime | None]
) -> str:
    # ready_at is set when ingestion finishes, but the column is nullable (rows inserted by hand,
    # fixtures): render NULL as "-", so a later re-ingest that sets it still changes the scope.
    docs = sorted(
        f"{doc}:{ready_at.isoformat() if ready_at else '-'}" for doc, ready_at in documents.items()
    )
    return hashlib.sha256("|".join([config_hash, prompt_version, *docs]).encode()).hexdigest()


@dataclass(frozen=True)
class CachedAnswer:
    answer: str
    sources: list[ev.Source]
    cited_sources: list[int]
    original_cost_usd: Decimal


LOOKUP = """
UPDATE response_cache
   SET hit_count = hit_count + 1, last_hit_at = now()
 WHERE tenant_id = %(tenant)s AND scope_hash = %(scope)s AND question_norm_hash = %(question)s
   AND expires_at > now()
RETURNING answer, sources, cited_sources, original_cost_usd
"""

# Guarded insert (docs/planning/IMPLEMENTATION_PLAN.md §9): stored only while every document in
# the scope is still the tenant's and ready, so a concurrent delete cannot leave its snippets in
# the cache.
STORE = """
INSERT INTO response_cache (tenant_id, scope_hash, question_norm_hash, answer, sources,
                            cited_sources, original_cost_usd, expires_at)
SELECT %(tenant)s, %(scope)s, %(question)s, %(answer)s, %(sources)s, %(cited)s, %(cost)s,
       now() + make_interval(days => %(ttl_days)s)
 WHERE (SELECT count(*) FROM documents
         WHERE id = ANY(%(docs)s) AND tenant_id = %(tenant)s AND status = 'ready')
       = cardinality(%(docs)s::uuid[])
ON CONFLICT (tenant_id, scope_hash, question_norm_hash) DO NOTHING
"""

SAVING = """
INSERT INTO cost_savings (request_id, mechanism, basis, baseline_usd, actual_usd, saved_usd)
VALUES (%s, %s, 'estimated', %s, %s, %s)
"""


async def lookup(
    conn: AsyncConnection, tenant: UUID, scope: str, question: str
) -> CachedAnswer | None:
    cur = await conn.execute(LOOKUP, {"tenant": tenant, "scope": scope, "question": question})
    row = await cur.fetchone()
    if row is None:
        return None
    answer, sources, cited, cost = row
    return CachedAnswer(
        answer=answer,
        sources=[ev.Source.model_validate(s) for s in sources],
        cited_sources=list(cited),
        original_cost_usd=Decimal(cost),
    )


async def store(
    conn: AsyncConnection,
    *,
    tenant: UUID,
    scope: str,
    question: str,
    documents: Sequence[UUID],
    answer: str,
    sources: Sequence[ev.Source],
    cited_sources: Sequence[int],
    cost_usd: Decimal,
    ttl_days: int,
) -> None:
    await conn.execute(
        STORE,
        {
            "tenant": tenant,
            "scope": scope,
            "question": question,
            "answer": answer,
            "sources": json.dumps([s.model_dump(mode="json", by_alias=True) for s in sources]),
            "cited": list(cited_sources),
            "cost": cost_usd,
            "ttl_days": ttl_days,
            "docs": list(documents),
        },
    )


async def record_saving(
    conn: AsyncConnection, request_id: UUID, mechanism: str, baseline: Decimal, actual: Decimal
) -> None:
    await conn.execute(SAVING, (request_id, mechanism, baseline, actual, max(baseline - actual, 0)))
