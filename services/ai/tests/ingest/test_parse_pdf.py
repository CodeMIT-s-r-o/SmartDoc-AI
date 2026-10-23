import pytest

from app.ingest.errors import (
    ENCRYPTED,
    INVALID_PDF,
    NO_TEXT_LAYER,
    PARSE_LIMIT_EXCEEDED,
    TOO_MANY_PAGES,
    IngestError,
)
from app.ingest.parse_pdf import clean_pages, parse_pdf
from tests.pdfs import decompression_bomb, encrypt, make_pdf

BODY = "Employees are entitled to twenty five days of paid annual leave."


def expect_code(code: str, data: bytes, **kwargs: int) -> IngestError:
    with pytest.raises(IngestError) as info:
        parse_pdf(data, **kwargs)
    assert info.value.code == code
    assert info.value.permanent
    return info.value


def test_extracts_text_per_page_with_offsets() -> None:
    parsed = parse_pdf(
        make_pdf([[f"Page one. {BODY}"], [f"Page two. {BODY}"], [f"Page three. {BODY}"]])
    )

    assert parsed.page_count == 3
    assert parsed.page_starts[0] == 0
    for number, start in enumerate(parsed.page_starts, start=1):
        assert parsed.text[start:].startswith(f"Page {['one', 'two', 'three'][number - 1]}.")


def test_removes_running_headers_and_footers() -> None:
    topics = ["leave", "travel", "expenses", "security"]
    pages = [
        [f"Chapter {n}: {topic}", f"Rules about {topic} apply to all.", BODY, f"See also {topic}."]
        for n, topic in enumerate(topics, start=1)
    ]
    parsed = parse_pdf(
        make_pdf(pages, header="ACME Corp Employee Handbook", footer="Page {page} of 4")
    )

    assert "ACME Corp Employee Handbook" not in parsed.text
    assert "of 4" not in parsed.text
    for topic in topics:
        assert f"Rules about {topic} apply to all." in parsed.text
        assert f"See also {topic}." in parsed.text


def test_clean_pages_joins_hyphenated_words_and_collapses_spaces() -> None:
    [page] = clean_pages(["The   leave  policy  applies  to  all  em-\nployees."])
    assert page == "The leave policy applies to all employees."


def test_clean_pages_splits_ligatures_but_keeps_superscripts() -> None:
    # Seen in the Slov-Lex print of the Labour Code: 290 "ﬀ" ligatures ("eﬀective").
    [page] = clean_pages(["The eﬀective date, the ﬁrst ﬂoor, as amended by Act¹."])

    assert page == "The effective date, the first floor, as amended by Act¹."


def test_rejects_scanned_pdfs_without_a_text_layer() -> None:
    expect_code(NO_TEXT_LAYER, make_pdf([[], [], ["tiny"]]))


def test_rejects_password_protected_pdfs() -> None:
    expect_code(ENCRYPTED, encrypt(make_pdf([[BODY]]), user_password="secret"))


def test_accepts_permissions_only_encryption() -> None:
    parsed = parse_pdf(encrypt(make_pdf([[BODY]]), user_password=""))
    assert "twenty five days" in parsed.text


def test_enforces_the_page_limit_before_extracting_text() -> None:
    expect_code(TOO_MANY_PAGES, make_pdf([[BODY]] * 3), max_pages=2)


def test_enforces_the_character_limit() -> None:
    expect_code(PARSE_LIMIT_EXCEEDED, make_pdf([[BODY]] * 3), max_chars=100)


def test_rejects_garbage_that_only_looks_like_a_pdf() -> None:
    expect_code(INVALID_PDF, b"%PDF-1.7\nthis is not really a pdf")


def test_stops_decompression_bombs() -> None:
    expect_code(PARSE_LIMIT_EXCEEDED, decompression_bomb())


def test_builds_nested_section_paths_from_the_outline() -> None:
    data = make_pdf(
        [["1 Leave", BODY], ["1.1 Annual leave", BODY], ["2 Travel", "Per diem is EUR 45."]],
        outline=[("1 Leave", 1, 0), ("1.1 Annual leave", 2, 1), ("2 Travel", 3, 0)],
    )

    parsed = parse_pdf(data)

    assert [s.path for s in parsed.sections] == [
        "1 Leave",
        "1 Leave > 1.1 Annual leave",
        "2 Travel",
    ]
    for section in parsed.sections:
        heading = section.path.split(" > ")[-1]
        assert parsed.text[section.start :].startswith(heading)


def test_falls_back_to_numbered_headings_without_an_outline() -> None:
    parsed = parse_pdf(
        make_pdf(
            [["1 Introduction", BODY, "1.1 Scope", BODY], ["2 Leave", BODY, "1. Submit the form."]]
        )
    )

    assert [s.path for s in parsed.sections] == [
        "1 Introduction",
        "1 Introduction > 1.1 Scope",
        "2 Leave",
    ]


def test_reads_legal_acts_by_their_section_markers_in_all_three_layouts() -> None:
    parsed = parse_pdf(
        make_pdf(
            [
                # Title on the next line (data protection, OSH, cybersecurity acts).
                ["Section 5", "Definitions", BODY, "Section 6", "Principle of Lawfulness", BODY],
                # Title on the line before, as in the Slov-Lex prints (Labour Code).
                ["Scope of the Labor Code", "§ 1", "(1) " + BODY, "§ 52a", "(1) " + BODY],
                # Marker and title on one line (travel allowances act).
                ["§ 5 Meals", BODY, "Article 4", "Competencies of Public Authorities", BODY],
            ]
        )
    )

    assert [s.path for s in parsed.sections] == [
        "Section 5 Definitions",
        "Section 6 Principle of Lawfulness",
        "§ 1 Scope of the Labor Code",
        "§ 52a",
        "§ 5 Meals",
        "Article 4 Competencies of Public Authorities",
    ]


def test_list_items_in_a_legal_act_never_become_sections() -> None:
    items = ["1. Transport", "2. Electronic communications", "3. Health care"]
    parsed = parse_pdf(
        make_pdf(
            [
                ["Section 1", "Subject Matter", *items, BODY, "Section 2", "Scope", BODY],
                ["Section 3", "Exemptions", BODY, "Section 4", "Duties", BODY, "Section 5", BODY],
            ]
        )
    )

    paths = [s.path for s in parsed.sections]
    assert paths[:2] == ["Section 1 Subject Matter", "Section 2 Scope"]
    assert not any(p.startswith(("1.", "2.", "3.")) for p in paths)
