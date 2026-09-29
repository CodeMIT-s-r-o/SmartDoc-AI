"""Context assembly: best-first by RRF, duplicates dropped, capped by count and by tokens."""

from dataclasses import dataclass

from app.rag.config import RagConfig
from app.rag.prompt import PromptDocument
from app.rag.retrieve import Candidate

SNIPPET_CHARS = 400


@dataclass(frozen=True)
class ContextChunk:
    n: int
    candidate: Candidate

    def prompt_document(self) -> PromptDocument:
        c = self.candidate
        return PromptDocument(self.n, c.title, c.section_path, c.page_start, c.page_end, c.content)


def assemble(candidates: list[Candidate], config: RagConfig) -> list[ContextChunk]:
    chosen: list[ContextChunk] = []
    seen: set[str] = set()
    tokens = 0
    for candidate in candidates:
        if candidate.content_hash in seen:
            continue
        if chosen and tokens + candidate.token_count > config.context_token_budget:
            break
        seen.add(candidate.content_hash)
        tokens += candidate.token_count
        chosen.append(ContextChunk(len(chosen) + 1, candidate))
        if len(chosen) == config.top_k:
            break
    return chosen


def snippet(content: str) -> str:
    text = " ".join(content.split())
    return text if len(text) <= SNIPPET_CHARS else text[: SNIPPET_CHARS - 1].rstrip() + "…"
