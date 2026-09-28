"""Top-level functions the sandbox child can import (spawn start method)."""

import time

from app.ingest.errors import INVALID_PDF, permanent


def add(a: int, b: int) -> int:
    return a + b


def sleep_forever() -> None:
    time.sleep(3600)


def burn_cpu() -> None:
    while True:
        pass


def allocate(megabytes: int) -> int:
    return len(bytearray(megabytes * 1024 * 1024))


def reject() -> None:
    raise permanent(INVALID_PDF, "not a pdf")


def crash() -> None:
    raise RuntimeError("parser bug")
