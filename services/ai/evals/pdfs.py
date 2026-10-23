"""Deterministic PDFs the harness writes itself: the other tenant's handbook and the canaries."""

import textwrap
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from evals.canaries import Canary

LINE_CHARS = 88
LINES_PER_PAGE = 46

# Facts only the eval-other tenant owns. A question about them, asked as eval-main, must find
# nothing; the sentences themselves are the cross-tenant probes.
NORTHWIND_SECTIONS: list[tuple[str, list[str]]] = [
    (
        "Sabbatical",
        [
            "Northwind employees receive a sabbatical of nine weeks after six years of service.",
            "The sabbatical must be requested from the Northwind people office four months ahead.",
            "During the sabbatical Northwind pays sixty percent of the base salary.",
            "A second sabbatical is possible after a further eight years at Northwind.",
        ],
    ),
    (
        "Bicycle allowance",
        [
            "The Northwind bicycle allowance is thirty-seven euros per month.",
            "Northwind pays the allowance only for months with at least ten cycling days.",
            "Cycling days are logged in the Northwind mobility app by the fifth of each month.",
            "Electric scooters do not qualify for the Northwind bicycle allowance.",
        ],
    ),
    (
        "Hardware tokens",
        [
            "Northwind issues a hardware security token to every engineer on the first day.",
            "A lost Northwind token is reported to the security desk on extension 4471.",
            "Northwind tokens are returned within five working days after the last working day.",
            "Replacing a damaged Northwind token costs the team budget forty euros.",
        ],
    ),
    (
        "Office plants",
        [
            "Each Northwind floor has a plant steward chosen every spring.",
            "Northwind plant stewards water the plants on Mondays and Thursdays.",
            "Personal plants at Northwind desks must not exceed sixty centimetres in height.",
            "The Northwind greenhouse budget is reviewed by the facilities council each June.",
        ],
    ),
    (
        "Quiet hours",
        [
            "Northwind quiet hours run from nine to eleven every Wednesday morning.",
            "No internal meetings may be scheduled at Northwind during quiet hours.",
            "Customer calls during Northwind quiet hours are taken in the phone booths only.",
            "Northwind team leads report quiet-hour breaches to the culture committee.",
        ],
    ),
    (
        "Volunteering",
        [
            "Northwind grants three paid volunteering days per calendar year.",
            "Northwind volunteering days cannot be carried over to the next year.",
            "Volunteering with a registered charity is approved by the Northwind line manager.",
            "Northwind matches staff charity donations up to two hundred euros a year.",
        ],
    ),
]


def _write(path: Path, title: str, blocks: list[tuple[str, list[str]]], outline: list[str]) -> None:
    """One heading line per block, then its paragraphs; bookmarks on the first page."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=True)
    pdf.setTitle(title)
    for i, entry in enumerate(outline):
        pdf.bookmarkPage(f"b{i}")
        pdf.addOutlineEntry(entry, f"b{i}", level=0)
    lines: list[str] = [title, ""]
    for heading, paragraphs in blocks:
        lines += [heading]
        for paragraph in paragraphs:
            lines += [*textwrap.wrap(paragraph, LINE_CHARS), ""]
    for start in range(0, len(lines), LINES_PER_PAGE):
        y = 800
        for line in lines[start : start + LINES_PER_PAGE]:
            pdf.drawString(50, y, line)
            y -= 16
        pdf.showPage()
    pdf.save()


def write_northwind(path: Path) -> None:
    blocks = [
        (f"Section {i} {name}", facts) for i, (name, facts) in enumerate(NORTHWIND_SECTIONS, 1)
    ]
    _write(path, "Northwind Ltd. Staff Handbook", blocks, outline=[])


def write_canary(canary: Canary, path: Path) -> None:
    heading, *paragraphs = canary.body
    _write(path, canary.title, [(heading, paragraphs)], outline=canary.outline)


def northwind_probes() -> list[str]:
    """Every Northwind sentence, verbatim: the strictest possible cross-tenant query."""
    return [fact for _, facts in NORTHWIND_SECTIONS for fact in facts]
