"""Builds small PDFs for tests (reportlab is a dev-only dependency)."""

import io
import zlib
from collections.abc import Sequence

from pypdf import PdfWriter
from pypdf.generic import NameObject, StreamObject
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def make_pdf(
    pages: Sequence[Sequence[str]],
    *,
    header: str | None = None,
    footer: str | None = None,
    outline: Sequence[tuple[str, int, int]] = (),
) -> bytes:
    """Text lines per page. `footer` may contain {page}. Outline entries: (title, page, level)."""
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    for number, lines in enumerate(pages, start=1):
        pdf.bookmarkPage(f"page{number}")
        if header:
            pdf.drawString(72, 800, header)
        y = 760
        for line in lines:
            pdf.drawString(72, y, line)
            y -= 14
        if footer:
            pdf.drawString(72, 40, footer.format(page=number))
        pdf.showPage()
    for title, page, level in outline:
        pdf.addOutlineEntry(title, f"page{page}", level=level)
    pdf.save()
    return buf.getvalue()


def encrypt(data: bytes, user_password: str, owner_password: str = "owner") -> bytes:
    writer = PdfWriter(clone_from=io.BytesIO(data))
    writer.encrypt(user_password=user_password, owner_password=owner_password)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def decompression_bomb(megabytes: int = 120) -> bytes:
    """A one-page PDF whose content stream inflates from ~100 KB to `megabytes` MB."""
    compressor = zlib.compressobj(9)
    chunk = b" " * (1024 * 1024)
    raw = b"".join(compressor.compress(chunk) for _ in range(megabytes)) + compressor.flush()

    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    stream = StreamObject()
    stream.set_data(b"")  # placeholder, replaced by the pre-compressed bytes below
    stream._data = raw
    stream[NameObject("/Filter")] = NameObject("/FlateDecode")
    page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
