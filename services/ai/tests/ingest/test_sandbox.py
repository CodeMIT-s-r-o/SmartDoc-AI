import sys
import time

import pytest

from app.ingest.errors import INVALID_PDF, PARSE_LIMIT_EXCEEDED, IngestError
from app.ingest.sandbox import run_limited
from tests.ingest import sandbox_helpers as helpers


def code_of(fn: object, *args: object, **limits: float) -> str:
    with pytest.raises(IngestError) as info:
        run_limited(fn, *args, **limits)  # type: ignore[arg-type]
    return info.value.code


def test_returns_the_result() -> None:
    assert run_limited(helpers.add, 2, 3) == 5


def test_enforces_the_wall_clock_limit() -> None:
    started = time.monotonic()
    assert code_of(helpers.sleep_forever, wall_seconds=1) == PARSE_LIMIT_EXCEEDED
    assert time.monotonic() - started < 10


def test_enforces_the_cpu_limit() -> None:
    assert code_of(helpers.burn_cpu, cpu_seconds=1, wall_seconds=20) == PARSE_LIMIT_EXCEEDED


@pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="RLIMIT_AS is enforced on Linux only"
)
def test_enforces_the_memory_limit() -> None:
    assert code_of(helpers.allocate, 600, memory_bytes=320 * 1024 * 1024) == PARSE_LIMIT_EXCEEDED


def test_propagates_ingest_errors_with_their_code() -> None:
    assert code_of(helpers.reject) == INVALID_PDF


def test_maps_unexpected_parser_crashes_to_invalid_pdf() -> None:
    assert code_of(helpers.crash) == INVALID_PDF
