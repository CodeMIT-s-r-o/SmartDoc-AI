"""Ingestion failures with stable codes, stored on documents.error_code and shown in the UI."""

from collections.abc import Callable

# The document itself is the problem: retrying cannot help.
NO_TEXT_LAYER = "NO_TEXT_LAYER"
ENCRYPTED = "ENCRYPTED"
TOO_MANY_PAGES = "TOO_MANY_PAGES"
INVALID_PDF = "INVALID_PDF"
PARSE_LIMIT_EXCEEDED = "PARSE_LIMIT_EXCEEDED"
DOCUMENT_UNAVAILABLE = "DOCUMENT_UNAVAILABLE"

# Infrastructure problems (network, OpenAI, database): retried with backoff.
INGESTION_FAILED = "INGESTION_FAILED"
ATTEMPTS_EXHAUSTED = "ATTEMPTS_EXHAUSTED"


class IngestError(Exception):
    """A failure with a code the UI understands. Permanent errors fail the job immediately."""

    def __init__(self, code: str, message: str, *, permanent: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.permanent = permanent

    def __reduce__(self) -> tuple[Callable[..., "IngestError"], tuple[str, str], dict[str, bool]]:
        # Picklable across the sandbox process boundary, including the keyword-only flag.
        return (_rebuild, (self.code, self.message), {"permanent": self.permanent})


def _rebuild(code: str, message: str) -> IngestError:
    return IngestError(code, message, permanent=True)


def permanent(code: str, message: str) -> IngestError:
    return IngestError(code, message, permanent=True)
