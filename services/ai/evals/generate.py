"""Generate dataset candidates from the ingested corpus (docs/IMPLEMENTATION_PLAN.md §8).

    make eval-generate

- golden_v1: 24 single-hop + 6 multi-hop questions with an answer and verbatim evidence. They are
  candidates until a person checks each against the PDF (make golden-review); the 10 hand-written
  items (unanswerable, cross-tenant, follow-up) are added from evals/handwritten.py.
- retrieval_synth_v1: one question per sampled chunk, gold = that chunk's document and pages.
  Labeled "synthetic, unreviewed"; used for retrieval metrics only.
- canaries_v1: the injection canaries from evals/canaries.py, written out for transparency.

Every model call is booked in the eval database's ledger (purpose "eval"). Sampling uses a fixed
seed, so rerunning picks the same passages; generation itself is not deterministic, which is why
the datasets are committed rather than regenerated.
"""

import asyncio
import json
import logging
import random
import re
from dataclasses import asdict, dataclass
from typing import Any
from uuid import UUID

from openai import AsyncOpenAI
from psycopg_pool import AsyncConnectionPool

from app.cost.ledger import record_llm_call
from app.db import create_pool
from app.rag.config import RagConfig
from evals.canaries import CANARIES
from evals.env import DATASETS_DIR, MAIN, eval_settings
from evals.handwritten import HANDWRITTEN

log = logging.getLogger("evals.generate")
SEED = 26
# Single-hop / multi-hop golden items and synthetic retrieval questions per document file.
PLAN = {
    "sk-labour-code-311-2001.pdf": (9, 2, 60),
    "sk-data-protection-act-18-2018.pdf": (5, 1, 35),
    "sk-osh-act-124-2006.pdf": (4, 1, 20),
    "sk-travel-allowances-283-2002.pdf": (4, 1, 20),
    "sk-cybersecurity-act-69-2018.pdf": (2, 1, 15),
}
# Passages that make poor questions: amendment notes, lists of EU acts, web-page chrome.
SKIP = re.compile(r"OJ L \d|ezbierky|Repealed|is deleted|shall be renumbered|Annex No\.", re.I)
MIN_TOKENS = 120

SINGLE = """You write evaluation questions for a question-answering system over Slovak laws
(English translations). From the passage below, write ONE question that an employee, HR manager
or compliance officer would realistically ask, whose answer is stated in the passage.

Rules:
- Ask in plain language. Never mention section or paragraph numbers, and do not copy the passage.
- The answer must be fully supported by the passage: one or two sentences, with exact numbers.
- evidence_quote: a VERBATIM excerpt of the passage (at most 300 characters) that proves the answer.
- If the passage has nothing worth asking about (only references, definitions of other acts,
  amendment notes), set usable to false.

Document: {title}
Section: {section}
<passage>
{content}
</passage>"""

MULTI = """You write evaluation questions for a question-answering system over Slovak laws
(English translations). Write ONE question that can only be answered by combining BOTH passages
below (for example a rule and its exception, or two conditions that apply together).

Rules:
- Plain language; never mention section or paragraph numbers.
- The answer must be supported by the two passages together: two sentences at most.
- evidence_quotes: one VERBATIM excerpt from each passage (at most 300 characters each), in order.
- If no sensible question needs both passages, set usable to false.

Document: {title}
<passage n="1" section="{section1}">
{content1}
</passage>
<passage n="2" section="{section2}">
{content2}
</passage>"""

SYNTH = """Write ONE short question that the passage below answers, as a user would type it into a
search box over Slovak laws (English translations). No section numbers. Also give a VERBATIM
excerpt of the passage (at most 200 characters) that contains the answer. If the passage answers
nothing useful, set usable to false.

<passage>
{content}
</passage>"""


def _schema(fields: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "name": "eval_item",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"usable": {"type": "boolean"}, **fields},
            "required": ["usable", *fields],
            "additionalProperties": False,
        },
    }


SINGLE_FORMAT = _schema(
    {
        "question": {"type": "string"},
        "answer": {"type": "string"},
        "evidence_quote": {"type": "string"},
    }
)
MULTI_FORMAT = _schema(
    {
        "question": {"type": "string"},
        "answer": {"type": "string"},
        "evidence_quotes": {"type": "array", "items": {"type": "string"}},
    }
)
SYNTH_FORMAT = _schema({"question": {"type": "string"}, "evidence_quote": {"type": "string"}})


@dataclass(frozen=True)
class Passage:
    chunk_id: UUID
    file: str
    title: str
    section: str | None
    page_start: int
    page_end: int
    content: str


def _squash(text: str) -> str:
    return " ".join(text.split())


def verbatim(quote: str, content: str) -> bool:
    """The model's evidence must be an exact excerpt (whitespace aside), or the item is dropped."""
    q = _squash(quote).strip(" .\"'")
    return len(q) >= 20 and q in _squash(content)


async def passages(pool: AsyncConnectionPool) -> dict[str, list[Passage]]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT c.id, d.original_filename, d.title, c.section_path, c.page_start,
                      c.page_end, c.content, c.token_count
                 FROM chunks c JOIN documents d ON d.id = c.document_id
                WHERE c.tenant_id = %s
                ORDER BY d.original_filename, c.chunk_index""",
            (MAIN,),
        )
        rows = await cur.fetchall()
    by_file: dict[str, list[Passage]] = {}
    for chunk_id, file, title, section, start, end, content, tokens in rows:
        if tokens >= MIN_TOKENS and not SKIP.search(content):
            by_file.setdefault(file, []).append(
                Passage(chunk_id, file, title, section, start, end, content)
            )
    return by_file


class Generator:
    def __init__(self, pool: AsyncConnectionPool, client: AsyncOpenAI, model: str) -> None:
        self.pool, self.client, self.model = pool, client, model

    async def ask(self, prompt: str, text_format: dict[str, Any]) -> dict[str, Any] | None:
        res = await self.client.responses.create(  # type: ignore[call-overload]
            model=self.model,
            input=prompt,
            reasoning={"effort": "low"},
            text={"format": text_format},
            max_output_tokens=800,
            store=False,
        )
        usage = res.usage.model_dump() if res.usage else {}
        details = usage.get("input_tokens_details") or {}
        await record_llm_call(
            self.pool,
            tenant_id=MAIN,
            purpose="eval",
            model=self.model,
            response_model=res.model,
            input_tokens=int(usage.get("input_tokens") or 0),
            cached_tokens=int(details.get("cached_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            reasoning_tokens=int(
                (usage.get("output_tokens_details") or {}).get("reasoning_tokens") or 0
            ),
        )
        item: dict[str, Any] = json.loads(res.output_text)
        return item if item.get("usable") else None


def _gold(p: Passage, quote: str) -> dict[str, Any]:
    return {
        "document": p.file,
        "title": p.title,
        "section": p.section,
        "pages": [p.page_start, p.page_end],
        "quote": _squash(quote),
    }


async def golden(
    gen: Generator, pool: dict[str, list[Passage]], rng: random.Random
) -> tuple[list[dict[str, Any]], set[UUID]]:
    items: list[dict[str, Any]] = []
    used: set[UUID] = set()
    for file, (n_single, n_multi, _) in PLAN.items():
        candidates = list(pool[file])
        rng.shuffle(candidates)
        short = file.removeprefix("sk-").split("-")[0]
        made = 0
        for p in candidates:
            if made == n_single:
                break
            out = await gen.ask(
                SINGLE.format(title=p.title, section=p.section or "-", content=p.content),
                SINGLE_FORMAT,
            )
            if out is None or not verbatim(out["evidence_quote"], p.content):
                continue
            made += 1
            used.add(p.chunk_id)
            items.append(
                {
                    "id": f"g-{short}-{made:02d}",
                    "type": "single_hop",
                    "question": out["question"],
                    "expected": "answer",
                    "answer": out["answer"],
                    "evidence": [_gold(p, out["evidence_quote"])],
                }
            )
        made = 0
        rest = [p for p in candidates if p.chunk_id not in used]
        for first, second in zip(rest[0::2], rest[1::2], strict=False):
            if made == n_multi:
                break
            if first.section == second.section:
                continue
            out = await gen.ask(
                MULTI.format(
                    title=first.title,
                    section1=first.section or "-",
                    content1=first.content,
                    section2=second.section or "-",
                    content2=second.content,
                ),
                MULTI_FORMAT,
            )
            quotes = out["evidence_quotes"] if out else []
            if (
                out is None
                or len(quotes) != 2
                or not (verbatim(quotes[0], first.content) and verbatim(quotes[1], second.content))
            ):
                continue
            made += 1
            used |= {first.chunk_id, second.chunk_id}
            items.append(
                {
                    "id": f"g-{short}-m{made}",
                    "type": "multi_hop",
                    "question": out["question"],
                    "expected": "answer",
                    "answer": out["answer"],
                    "evidence": [_gold(first, quotes[0]), _gold(second, quotes[1])],
                }
            )
        log.info(
            "golden %-40s %d items",
            file,
            sum(1 for i in items if i["evidence"][0]["document"] == file),
        )
    return items, used


async def synth(
    gen: Generator, pool: dict[str, list[Passage]], used: set[UUID], rng: random.Random
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for file, (_, _, n_synth) in PLAN.items():
        candidates = [p for p in pool[file] if p.chunk_id not in used]
        rng.shuffle(candidates)
        made = 0
        for p in candidates:
            if made == n_synth:
                break
            out = await gen.ask(SYNTH.format(content=p.content), SYNTH_FORMAT)
            if out is None or not verbatim(out["evidence_quote"], p.content):
                continue
            made += 1
            items.append(
                {
                    "id": f"r-{len(items) + 1:03d}",
                    "question": out["question"],
                    "gold": _gold(p, out["evidence_quote"]),
                }
            )
        log.info("synth  %-40s %d items", file, made)
    return items


def check_handwritten(corpus: dict[str, list[Passage]]) -> None:
    """Hand-written evidence must quote the ingested text on the stated page, as generated does."""
    for item in HANDWRITTEN:
        for ev in item["evidence"]:
            pages = range(ev["pages"][0], ev["pages"][1] + 1)
            found = any(
                verbatim(ev["quote"], p.content)
                for p in corpus.get(ev["document"], [])
                if p.page_start in pages or p.page_end in pages
            )
            if not found:
                raise SystemExit(f"{item['id']}: evidence not found verbatim on page {ev['pages']}")


def _write(name: str, rows: list[dict[str, Any]]) -> None:
    DATASETS_DIR.mkdir(parents=True, exist_ok=True)
    with (DATASETS_DIR / name).open("w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


async def run() -> None:
    settings = eval_settings()
    if settings.openai_api_key is None:
        raise SystemExit("OPENAI_API_KEY is required (set it in .env)")
    rng = random.Random(SEED)
    db = create_pool(settings, max_size=2)
    await db.open(wait=True)
    try:
        corpus = await passages(db)
        check_handwritten(corpus)
        async with AsyncOpenAI(
            api_key=settings.openai_api_key.get_secret_value(), max_retries=2
        ) as client:
            gen = Generator(db, client, RagConfig().chat_model)
            generated, used = await golden(gen, corpus, rng)
            synthetic = await synth(gen, corpus, used, rng)
    finally:
        await db.close()
    pending = {"status": "pending", "notes": ""}
    _write("golden_v1.jsonl", [{**item, "review": pending} for item in [*generated, *HANDWRITTEN]])
    _write(
        "retrieval_synth_v1.jsonl",
        [{**item, "review": {"status": "unreviewed"}} for item in synthetic],
    )
    _write("canaries_v1.jsonl", [asdict(c) for c in CANARIES])
    log.info(
        "golden %d (%d generated + %d hand-written), synth %d, canaries %d",
        len(generated) + len(HANDWRITTEN),
        len(generated),
        len(HANDWRITTEN),
        len(synthetic),
        len(CANARIES),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for noisy in ("httpx", "httpx2", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    asyncio.run(run())
