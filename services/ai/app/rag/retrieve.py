"""Scope verification and hybrid retrieval, both inside the caller's transaction.

Hybrid = HNSW cosine top-N  +  Postgres full-text top-N, fused with Reciprocal Rank Fusion (k=60).
The keyword branch uses an OR tsquery: plainto/websearch_to_tsquery AND every term, which makes
the branch return nothing for natural-language questions. ts_rank_cd has no IDF term, so it is
reported as `fts_rank`, never as BM25.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from pgvector import HalfVector
from psycopg import AsyncConnection

from app.rag.config import RagConfig

RRF_K = 60
MAX_CANDIDATES = 20


class ScopeMismatch(Exception):
    """The requested document set is not entirely the tenant's ready documents."""


@dataclass(frozen=True)
class Candidate:
    chunk_id: UUID
    document_id: UUID
    title: str
    section_path: str | None
    page_start: int
    page_end: int
    content: str
    content_hash: str
    token_count: int
    vector_score: float | None
    fts_rank: float | None
    matched_lexemes: int | None
    rrf_score: float


@dataclass(frozen=True)
class Retrieval:
    candidates: list[Candidate]
    max_cos: float | None
    max_matched_lexemes: int
    fts_nonempty: bool


SCOPE = """
SELECT id, ready_at FROM documents
 WHERE tenant_id = %(tenant)s AND id = ANY(%(docs)s) AND status = 'ready'
   FOR SHARE
"""


async def verify_scope(
    conn: AsyncConnection, tenant: UUID, document_ids: Sequence[UUID]
) -> dict[UUID, datetime]:
    """Row locks keep a concurrent delete waiting until this retrieval commits.

    Returns each document's ready_at: a re-ingest moves it, which changes the cache scope.
    """
    wanted = set(document_ids)
    cur = await conn.execute(SCOPE, {"tenant": tenant, "docs": list(wanted)})
    found: dict[UUID, datetime] = {row[0]: row[1] for row in await cur.fetchall()}
    if set(found) != wanted or not wanted:
        raise ScopeMismatch(
            f"{len(wanted - set(found))} of {len(wanted)} documents are not in scope"
        )
    return found


_Q = """
q AS (
    SELECT replace(plainto_tsquery('english', %(question)s)::text, ' & ', ' | ')::tsquery AS tsq,
           tsvector_to_array(to_tsvector('english', %(question)s)) AS lex
)"""

_SEM = """
sem_raw AS (
    -- A single-table predicate keeps the HNSW plan; relaxed_order may be out of order: re-rank.
    SELECT id, embedding <=> %(vec)s AS dist FROM chunks
     WHERE tenant_id = %(tenant)s AND document_id = ANY(%(docs)s)
     ORDER BY embedding <=> %(vec)s
     LIMIT %(n)s
),
sem AS (SELECT id, 1 - dist AS cos, row_number() OVER (ORDER BY dist) AS r FROM sem_raw)"""

_NO_SEM = """
sem AS (SELECT NULL::uuid AS id, NULL::float8 AS cos, NULL::bigint AS r WHERE false)"""

_KW = """
kw AS (
    SELECT c.id,
           ts_rank_cd(c.tsv, q.tsq) AS fts,
           cardinality(ARRAY(SELECT unnest(tsvector_to_array(c.tsv))
                             INTERSECT SELECT unnest(q.lex))) AS matched,
           row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC) AS r
      FROM chunks c, q
     WHERE c.tenant_id = %(tenant)s AND c.document_id = ANY(%(docs)s) AND c.tsv @@ q.tsq
     ORDER BY fts DESC
     LIMIT %(n)s
)"""

_NO_KW = """
kw AS (SELECT NULL::uuid AS id, NULL::real AS fts, NULL::int AS matched, NULL::bigint AS r
        WHERE false)"""

_FUSE = f"""
fused AS (
    SELECT coalesce(s.id, k.id) AS id, s.cos, k.fts, k.matched,
           coalesce(1.0 / ({RRF_K} + s.r), 0) + coalesce(1.0 / ({RRF_K} + k.r), 0) AS rrf
      FROM sem s FULL OUTER JOIN kw k ON k.id = s.id
)
SELECT f.id, c.document_id, d.title, c.section_path, c.page_start, c.page_end, c.content,
       c.content_hash, c.token_count, f.cos, f.fts, f.matched, f.rrf,
       (SELECT max(cos) FROM sem) AS max_cos,
       (SELECT coalesce(max(matched), 0) FROM kw) AS max_matched,
       (SELECT count(*) FROM kw) AS kw_count
  FROM fused f
  JOIN chunks c ON c.id = f.id
  JOIN documents d ON d.id = c.document_id
 ORDER BY f.rrf DESC, f.id
 LIMIT {MAX_CANDIDATES}
"""


def _sql(vector: bool, keyword: bool) -> str:
    ctes = [_Q, _SEM if vector else _NO_SEM, _KW if keyword else _NO_KW]
    return "WITH " + ",".join(ctes) + "," + _FUSE


async def retrieve(
    conn: AsyncConnection,
    *,
    tenant: UUID,
    document_ids: Sequence[UUID],
    question: str,
    query_vector: list[float] | None,
    config: RagConfig,
) -> Retrieval:
    """Without a query vector (embeddings unavailable) only the keyword branch runs."""
    vector = query_vector is not None
    keyword = config.hybrid_enabled or not vector
    await conn.execute("SET LOCAL hnsw.ef_search = 100")
    await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
    cur = await conn.execute(
        _sql(vector, keyword),
        {
            "tenant": tenant,
            "docs": list(document_ids),
            "question": question,
            "vec": HalfVector(query_vector) if query_vector is not None else None,
            "n": config.candidates_per_branch,
        },
    )
    rows = await cur.fetchall()
    candidates = [
        Candidate(
            chunk_id=r[0],
            document_id=r[1],
            title=r[2],
            section_path=r[3],
            page_start=r[4],
            page_end=r[5],
            content=r[6],
            content_hash=r[7],
            token_count=r[8],
            vector_score=None if r[9] is None else float(r[9]),
            fts_rank=None if r[10] is None else float(r[10]),
            matched_lexemes=r[11],
            rrf_score=float(r[12]),
        )
        for r in rows
    ]
    first = rows[0] if rows else None
    return Retrieval(
        candidates=candidates,
        max_cos=None if first is None or first[13] is None else float(first[13]),
        max_matched_lexemes=int(first[14]) if first else 0,
        fts_nonempty=bool(first and first[15]),
    )


def gate_fires(retrieval: Retrieval, config: RagConfig) -> bool:
    """Weak on both signals: nothing semantically close and hardly any shared terms."""
    weak_vector = retrieval.max_cos is None or retrieval.max_cos < config.retrieval_gate_tau
    weak_keyword = retrieval.max_matched_lexemes < config.gate_min_lexemes
    return weak_vector and weak_keyword
