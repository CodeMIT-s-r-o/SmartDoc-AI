"""Runs the PDF parser in a child process with memory, CPU and wall-clock limits.

A hostile PDF (decompression bomb, pathological page tree) can at worst kill the child: the
worker survives and records PARSE_LIMIT_EXCEEDED.
"""

import multiprocessing
import resource
import sys
from collections.abc import Callable
from multiprocessing.connection import Connection
from typing import Any

from app.ingest.errors import INVALID_PDF, PARSE_LIMIT_EXCEEDED, IngestError, permanent

MEMORY_LIMIT_BYTES = 320 * 1024 * 1024
CPU_LIMIT_SECONDS = 60
WALL_LIMIT_SECONDS = 90


def _child(
    conn: Connection, fn: Callable[..., Any], args: tuple[Any, ...], memory: int, cpu: int
) -> None:
    # Linux enforces RLIMIT_AS; macOS does not, so local test runs rely on the other limits.
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    try:
        conn.send(("ok", fn(*args)))
    except IngestError as exc:
        conn.send(("error", exc))
    except MemoryError:
        conn.send(("error", permanent(PARSE_LIMIT_EXCEEDED, "Memory limit exceeded")))
    except Exception as exc:  # anything else inside the parser means the file is unreadable
        conn.send(("error", permanent(INVALID_PDF, f"{type(exc).__name__}: {str(exc)[:200]}")))
    finally:
        conn.close()


def run_limited[T](
    fn: Callable[..., T],
    *args: Any,
    memory_bytes: int = MEMORY_LIMIT_BYTES,
    cpu_seconds: int = CPU_LIMIT_SECONDS,
    wall_seconds: float = WALL_LIMIT_SECONDS,
) -> T:
    """Blocking; call it via asyncio.to_thread. `fn` must be importable (spawn start method)."""
    ctx = multiprocessing.get_context("spawn")
    receiver, sender = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_child, args=(sender, fn, args, memory_bytes, cpu_seconds), daemon=True
    )
    proc.start()
    sender.close()
    try:
        if not receiver.poll(wall_seconds):
            raise permanent(PARSE_LIMIT_EXCEEDED, f"Parsing took longer than {wall_seconds:.0f} s")
        try:
            status, payload = receiver.recv()
        except EOFError as exc:
            # Killed by the kernel (RLIMIT_CPU -> SIGXCPU, RLIMIT_AS -> abort, OOM killer).
            raise permanent(
                PARSE_LIMIT_EXCEEDED, "The parser was killed by a resource limit"
            ) from exc
    finally:
        receiver.close()
        if proc.is_alive():
            proc.kill()
        proc.join(5)
    if status == "error":
        raise payload
    result: T = payload
    return result
