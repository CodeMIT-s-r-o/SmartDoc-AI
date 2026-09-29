"""Untrusted text (document content, titles, section names, questions) before it enters a prompt."""

import html
import re

# C0/C1 controls except tab and newline; bidi embeddings/overrides/isolates; zero-width characters.
_INVISIBLE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f​-‏‪-‮⁠-⁤⁦-⁩﻿]")


def strip_invisible(text: str) -> str:
    return _INVISIBLE.sub("", text)


def escape(text: str) -> str:
    """Neutralize markup so a document cannot close <document> or open a fake <question>."""
    return html.escape(strip_invisible(text), quote=True)
