from app.ingest.chunk import CHUNK_TOKENS, chunk_document
from app.ingest.parse_pdf import PAGE_SEPARATOR, ParsedPdf, Section

SENTENCE = "Employees accrue leave monthly and must request it in the HR portal ahead of time. "


def parsed(pages: list[str], sections: list[tuple[str, str]]) -> ParsedPdf:
    """sections: (path, heading text that starts the section)."""
    text = PAGE_SEPARATOR.join(pages)
    starts, offset = [], 0
    for page in pages:
        starts.append(offset)
        offset += len(page) + len(PAGE_SEPARATOR)
    return ParsedPdf(
        text=text,
        page_starts=starts,
        sections=[Section(path, text.index(heading)) for path, heading in sections],
        page_count=len(pages),
    )


def test_chunks_point_at_their_exact_text_and_pages() -> None:
    doc = parsed(["Intro " + SENTENCE * 40, SENTENCE * 40, "Tail " + SENTENCE * 5], [])

    chunks = chunk_document(doc)

    assert len(chunks) > 3
    for chunk in chunks:
        assert doc.text[chunk.char_start : chunk.char_start + len(chunk.content)] == chunk.content
        assert 1 <= chunk.page_start <= chunk.page_end <= 3
        assert chunk.token_count <= CHUNK_TOKENS
    assert chunks[0].page_start == 1
    assert chunks[-1].page_end == 3
    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_a_chunk_merged_across_short_pages_reports_every_page() -> None:
    doc = parsed(
        ["Page one. " + SENTENCE * 3, "Page two. " + SENTENCE * 3, "Page three. " + SENTENCE], []
    )

    [chunk] = chunk_document(doc)

    assert (chunk.page_start, chunk.page_end) == (1, 3)


def test_never_crosses_a_section_boundary() -> None:
    doc = parsed(
        ["Preamble text. " + SENTENCE, "1 Leave\n" + SENTENCE * 30, "2 Travel\n" + SENTENCE * 30],
        [("1 Leave", "1 Leave"), ("2 Travel", "2 Travel")],
    )

    chunks = chunk_document(doc)

    assert chunks[0].section_path is None
    assert "1 Leave" not in chunks[0].content
    leave = [c for c in chunks if c.section_path == "1 Leave"]
    travel = [c for c in chunks if c.section_path == "2 Travel"]
    assert leave and travel
    assert all("2 Travel" not in c.content for c in leave)
    assert all(c.page_start == 2 and c.page_end == 2 for c in leave)


def test_consecutive_chunks_overlap() -> None:
    doc = parsed([" ".join(f"Rule {i}: {SENTENCE}" for i in range(80))], [])

    chunks = chunk_document(doc)

    assert len(chunks) >= 2
    first, second = chunks[0], chunks[1]
    assert second.char_start < first.char_start + len(first.content)


def test_skips_empty_sections() -> None:
    doc = parsed(["1 Empty\n\n2 Full\n" + SENTENCE], [("1 Empty", "1 Empty"), ("2 Full", "2 Full")])
    paths = [c.section_path for c in chunk_document(doc)]
    assert "2 Full" in paths


def test_skips_heading_only_sections() -> None:
    doc = parsed(
        ["1 Leave\n1.1 Annual\n" + SENTENCE * 3],
        [("1 Leave", "1 Leave"), ("1 Leave > 1.1 Annual", "1.1 Annual")],
    )

    chunks = chunk_document(doc)

    assert [c.section_path for c in chunks] == ["1 Leave > 1.1 Annual"]
    assert chunks[0].content.startswith("1.1 Annual")
