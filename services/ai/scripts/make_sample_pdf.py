"""Generates a synthetic, deterministic employee handbook PDF for local testing.

    uv run python scripts/make_sample_pdf.py out.pdf [--pages 100]

It has what real policy PDFs have: an outline (chapters and sections), numbered headings,
a running header, "Page N of M" footers, and paragraphs that wrap across pages. Every fact is
generated, so nothing licensed or personal ever ends up in the repo.
"""

import argparse
import random
import textwrap

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

TOPICS = [
    ("Working hours", ["Core hours", "Overtime", "Remote work", "Public holidays"]),
    ("Annual leave", ["Entitlement", "Requesting leave", "Carry-over", "Sick leave"]),
    ("Travel", ["Booking", "Per diem", "Mileage", "Insurance"]),
    ("Expenses", ["Approval limits", "Receipts", "Corporate cards", "Late claims"]),
    ("IT security", ["Passwords", "Multi-factor authentication", "Devices", "Incidents"]),
    ("Health and safety", ["First aid", "Fire drills", "Ergonomics", "Reporting accidents"]),
    ("Learning", ["Training budget", "Conferences", "Certifications", "Mentoring"]),
    ("Benefits", ["Pension", "Meal vouchers", "Sports card", "Parental leave"]),
    ("Conduct", ["Code of conduct", "Conflicts of interest", "Gifts", "Whistleblowing"]),
    ("Leaving the company", ["Notice period", "Handover", "Equipment return", "References"]),
]
FACTS = [
    "Employees must submit the request in the HR portal at least {n} working days in advance.",
    "The limit is EUR {amount} per calendar year unless the department head approves more.",
    "Managers respond within {n} working days; silence does not count as approval.",
    "Exceptions require written approval from the People team and are reviewed every {n} months.",
    "The policy applies to all permanent employees after a probation period of {n} months.",
    "Contractors follow the terms of their own agreement and are not covered by this section.",
    "Records are kept for {n} years in line with the retention schedule.",
    "Questions about this section go to the People team via the service desk.",
]
LINE_CHARS = 90
LINES_PER_PAGE = 48


def paragraph(rng: random.Random) -> str:
    return " ".join(
        rng.choice(FACTS).format(n=rng.randint(2, 30), amount=rng.randrange(100, 5000, 50))
        for _ in range(rng.randint(3, 6))
    )


def build(path: str, pages: int, seed: int = 7) -> None:
    rng = random.Random(seed)
    lines: list[tuple[str, str | None, int]] = []  # (text, outline title, outline level)
    section_count = sum(len(subsections) for _, subsections in TOPICS)
    # Fill every section to an equal share of the requested page count.
    lines_per_section = pages * LINES_PER_PAGE // section_count - 2
    for number, (chapter, subsections) in enumerate(TOPICS, start=1):
        lines.append((f"{number} {chapter}", f"{number} {chapter}", 0))
        for sub, section in enumerate(subsections, start=1):
            heading = f"{number}.{sub} {section}"
            lines.append((heading, heading, 1))
            start = len(lines)
            while len(lines) - start < lines_per_section:
                lines.extend((line, None, 0) for line in textwrap.wrap(paragraph(rng), LINE_CHARS))
                lines.append(("", None, 0))

    total = -(-len(lines) // LINES_PER_PAGE)
    pdf = canvas.Canvas(path, pagesize=A4)
    pdf.setTitle("ACME Corp Employee Handbook (synthetic)")
    for page in range(total):
        pdf.setFont("Helvetica", 8)
        pdf.drawString(72, 810, "ACME Corp - Employee Handbook - Internal")
        pdf.setFont("Helvetica", 10)
        y = 780
        for text, outline, level in lines[page * LINES_PER_PAGE : (page + 1) * LINES_PER_PAGE]:
            if outline:
                key = f"s{len(outline)}-{page}-{y}"
                pdf.bookmarkHorizontal(key, 72, y + 12)
                pdf.addOutlineEntry(outline, key, level=level)
            pdf.drawString(72, y, text)
            y -= 15
        pdf.setFont("Helvetica", 8)
        pdf.drawString(72, 30, f"Page {page + 1} of {total}")
        pdf.showPage()
    pdf.save()
    print(f"wrote {path}: {total} pages")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output")
    parser.add_argument("--pages", type=int, default=100)
    args = parser.parse_args()
    build(args.output, args.pages)
