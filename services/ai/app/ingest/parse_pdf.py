"""PDF -> cleaned text with page offsets and section headings. Runs inside the sandbox.

Every byte of the PDF is attacker-controlled: limits are checked before the expensive work, and
pypdf's own decompression cap (LimitReachedError) is mapped to PARSE_LIMIT_EXCEEDED.
"""

import io
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from pypdf import PageObject, PdfReader
from pypdf.errors import FileNotDecryptedError, LimitReachedError, PdfReadError
from pypdf.generic import ArrayObject, Destination

from app.ingest.errors import (
    ENCRYPTED,
    INVALID_PDF,
    NO_TEXT_LAYER,
    PARSE_LIMIT_EXCEEDED,
    TOO_MANY_PAGES,
    permanent,
)

MAX_PAGES = 300
MAX_CHARS = 3_000_000
MIN_PAGE_CHARS = 20
PAGE_SEPARATOR = "\n\n"
MAX_HEADING_CHARS = 200
# Numbered headings ("4.2 Annual leave", "Article 5 ...", "§ 3 ..."), used when there is no outline.
HEADING = re.compile(r"^(?P<num>\d+(?:\.\d+)*\.?|Article \d+|§\s?\d+)\s+\S.{0,80}$")


@dataclass(frozen=True)
class Section:
    """A heading path ("4 Leave > 4.2 Annual leave") starting at a character offset in the text."""

    path: str
    start: int


@dataclass(frozen=True)
class ParsedPdf:
    text: str
    """Offset of each page in `text`; page N (1-based) starts at page_starts[N - 1]."""
    page_starts: list[int]
    sections: list[Section]
    page_count: int


def parse_pdf(data: bytes, max_pages: int = MAX_PAGES, max_chars: int = MAX_CHARS) -> ParsedPdf:
    reader = _open(data)
    page_count = _page_count(reader)
    if page_count > max_pages:
        raise permanent(TOO_MANY_PAGES, f"{page_count} pages; the limit is {max_pages}")

    raw_pages = _extract_pages(reader, max_chars)
    if sum(len(p.strip()) < MIN_PAGE_CHARS for p in raw_pages) > page_count / 2:
        raise permanent(NO_TEXT_LAYER, "Most pages have no text layer (scanned PDF?)")

    pages = clean_pages(raw_pages)
    page_starts: list[int] = []
    offset = 0
    for page in pages:
        page_starts.append(offset)
        offset += len(page) + len(PAGE_SEPARATOR)
    text = PAGE_SEPARATOR.join(pages)

    sections = _outline_sections(reader, pages, page_starts) or _numbered_sections(text)
    return ParsedPdf(text=text, page_starts=page_starts, sections=sections, page_count=page_count)


def _open(data: bytes) -> PdfReader:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            # An empty user password (permissions-only encryption) is fine; anything else is not.
            raise permanent(ENCRYPTED, "The PDF is password-protected")
        return reader
    except FileNotDecryptedError as exc:
        raise permanent(ENCRYPTED, "The PDF is password-protected") from exc
    except LimitReachedError as exc:
        raise permanent(PARSE_LIMIT_EXCEEDED, str(exc)[:200]) from exc
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise permanent(INVALID_PDF, f"Unreadable PDF: {str(exc)[:200]}") from exc


def _page_count(reader: PdfReader) -> int:
    try:
        return len(reader.pages)
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise permanent(INVALID_PDF, f"Unreadable page tree: {str(exc)[:200]}") from exc


def _extract_pages(reader: PdfReader, max_chars: int) -> list[str]:
    pages: list[str] = []
    total = 0
    try:
        for page in reader.pages:
            _decode_content_streams(page)
            text = page.extract_text() or ""
            total += len(text)
            if total > max_chars:
                raise permanent(PARSE_LIMIT_EXCEEDED, f"More than {max_chars:,} characters of text")
            pages.append(text)
    except LimitReachedError as exc:
        raise permanent(PARSE_LIMIT_EXCEEDED, str(exc)[:200]) from exc
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise permanent(INVALID_PDF, f"Unreadable page content: {str(exc)[:200]}") from exc
    return pages


def _decode_content_streams(page: PageObject) -> None:
    """Decompress the page's content streams up front. extract_text() swallows pypdf's
    decompression-limit error and returns "", which would disguise a bomb as NO_TEXT_LAYER.
    pypdf caches the decoded data, so extraction does not decompress it again."""
    contents = page.get("/Contents")
    if contents is None:
        return
    resolved = contents.get_object()
    streams = resolved if isinstance(resolved, ArrayObject) else [resolved]
    for stream in streams:
        stream.get_object().get_data()


_DIGITS = re.compile(r"\d+")
_SPACES = re.compile("[ \t\u00a0]+")
_HYPHENATED = re.compile(r"(\w)-\n(\w)")
_BLANK_LINES = re.compile(r"\n{3,}")
# Header/footer candidates: short lines this close to the top or bottom of a page.
_EDGE_LINES = 2
_MAX_EDGE_LINE_CHARS = 120


def _normalized(line: str) -> str:
    return _SPACES.sub(" ", _DIGITS.sub("#", line)).strip().lower()


def _edge_indexes(lines: list[str]) -> set[int]:
    """Top and bottom lines, never overlapping, so a short page keeps its middle as body text."""
    edge = min(_EDGE_LINES, len(lines) // 3)
    candidates = set(range(edge)) | set(range(len(lines) - edge, len(lines)))
    return {i for i in candidates if len(lines[i]) <= _MAX_EDGE_LINE_CHARS}


def clean_pages(pages: list[str]) -> list[str]:
    """Drop running headers/footers, join hyphenated words, collapse whitespace."""
    split = [[_SPACES.sub(" ", line).strip() for line in page.splitlines()] for page in pages]

    repeated: set[str] = set()
    if len(pages) >= 3:
        counts: Counter[str] = Counter()
        for lines in split:
            counts.update({_normalized(lines[i]) for i in _edge_indexes(lines) if lines[i]})
        repeated = {line for line, n in counts.items() if n >= len(pages) / 2}

    cleaned: list[str] = []
    for lines in split:
        edges = _edge_indexes(lines)
        kept = [
            line
            for i, line in enumerate(lines)
            if not (i in edges and _normalized(line) in repeated)
        ]
        text = _HYPHENATED.sub(r"\1\2", "\n".join(kept))
        cleaned.append(_BLANK_LINES.sub("\n\n", text).strip())
    return cleaned


def _safe_heading(title: str) -> str:
    """Outline titles are attacker-controlled: drop control/format characters, cap the length."""
    return "".join(ch for ch in title if unicodedata.category(ch)[0] != "C").strip()[
        :MAX_HEADING_CHARS
    ]


def _outline_sections(reader: PdfReader, pages: list[str], page_starts: list[int]) -> list[Section]:
    try:
        entries = list(_walk_outline(reader, reader.outline, []))
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError):
        return []

    sections: list[Section] = []
    for path, page_index in entries:
        if page_index is None or not 0 <= page_index < len(pages):
            continue
        heading = path[-1]
        # Start at the heading's own line when it can be found on that page, else at the page start.
        found = pages[page_index].lower().find(heading.lower())
        start = page_starts[page_index] + max(found, 0)
        sections.append(Section(path=" > ".join(path), start=start))
    sections.sort(key=lambda s: s.start)
    return sections


def _walk_outline(
    reader: PdfReader, items: Sequence[object], parents: list[str]
) -> "list[tuple[list[str], int | None]]":
    out: list[tuple[list[str], int | None]] = []
    last: list[str] | None = None
    for item in items:
        if isinstance(item, list):
            out.extend(_walk_outline(reader, item, last or parents))
        elif isinstance(item, Destination):
            title = _safe_heading(str(item.title or ""))
            if not title:
                continue
            last = [*parents, title]
            out.append((last, reader.get_destination_page_number(item)))
    return out


def _numbered_sections(text: str) -> list[Section]:
    """Fallback: numbered headings, nested by their numbering depth (1 > 1.2 > 1.2.3)."""
    sections: list[Section] = []
    stack: list[tuple[int, str]] = []
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        match = HEADING.match(stripped)
        if match and not stripped.endswith((".", ",", ";", ":")):
            num = match.group("num")
            depth = num.rstrip(".").count(".") + 1 if num[0].isdigit() else 1
            stack = [entry for entry in stack if entry[0] < depth]
            stack.append((depth, _safe_heading(stripped)))
            sections.append(Section(path=" > ".join(h for _, h in stack), start=offset))
        offset += len(line)
    return sections
