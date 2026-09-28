"""Section-aware chunking with exact page ranges for citations."""

from bisect import bisect_right
from dataclasses import dataclass
from functools import lru_cache

import tiktoken
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.ingest.parse_pdf import ParsedPdf

ENCODING = "cl100k_base"
CHUNK_TOKENS = 500
CHUNK_OVERLAP_TOKENS = 75


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    section_path: str | None
    page_start: int
    page_end: int
    char_start: int
    token_count: int


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding(ENCODING)


@lru_cache(maxsize=1)
def _splitter() -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter.from_tiktoken_encoder(
        encoding_name=ENCODING,
        chunk_size=CHUNK_TOKENS,
        chunk_overlap=CHUNK_OVERLAP_TOKENS,
        separators=["\n\n", "\n", ". ", " ", ""],
        # Not add_start_index: it subtracts the overlap as characters while ours is in tokens, so
        # its offsets drift and page ranges come out wrong. chunk_document locates offsets itself.
    )


def _page_of(page_starts: list[int], offset: int) -> int:
    """1-based page containing a character offset."""
    return max(bisect_right(page_starts, offset), 1)


def chunk_document(parsed: ParsedPdf) -> list[Chunk]:
    """Split per section first (a chunk never spans two sections), then by tokens within it."""
    starts = [s.start for s in parsed.sections]
    spans: list[tuple[int, int, str | None]] = []
    if not starts or starts[0] > 0:
        spans.append((0, starts[0] if starts else len(parsed.text), None))
    for i, section in enumerate(parsed.sections):
        end = starts[i + 1] if i + 1 < len(starts) else len(parsed.text)
        spans.append((section.start, end, section.path))

    chunks: list[Chunk] = []
    for start, end, path in spans:
        section_text = parsed.text[start:end]
        # Skip empty sections and heading-only ones ("1 Leave" directly followed by "1.1 ..."):
        # a chunk that is just a title is retrieval noise. The heading stays in the section path.
        if not section_text.strip() or (
            path and not section_text.strip().partition("\n")[2].strip()
        ):
            continue
        cursor = 0
        for content in _splitter().split_text(section_text):
            # Chunks come in order, and each one starts after the previous one's start.
            found = section_text.find(content, cursor)
            local = found if found >= 0 else cursor
            cursor = local + 1
            char_start = start + local
            chunks.append(
                Chunk(
                    index=len(chunks),
                    content=content,
                    section_path=path,
                    page_start=_page_of(parsed.page_starts, char_start),
                    page_end=_page_of(parsed.page_starts, char_start + len(content) - 1),
                    char_start=char_start,
                    token_count=len(_encoding().encode(content)),
                )
            )
    return chunks
