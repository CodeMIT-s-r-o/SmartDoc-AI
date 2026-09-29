from app.rag.citations import parse_citations, strip_markers


def test_parses_single_and_grouped_markers() -> None:
    report = parse_citations("You get 25 days [1]. Carry-over is 5 days [2, 3]. Ask HR.", 3)
    assert report.cited == [1, 2, 3]
    assert report.valid
    assert report.coverage == 2 / 3


def test_flags_markers_outside_the_context() -> None:
    assert not parse_citations("Made up [7].", 5).valid


def test_an_answer_without_markers_has_zero_coverage() -> None:
    report = parse_citations("No citations here.", 5)
    assert (report.cited, report.valid, report.coverage) == ([], True, 0.0)


def test_strip_markers() -> None:
    assert strip_markers("25 days [1]. Five [2, 3].") == "25 days. Five."
