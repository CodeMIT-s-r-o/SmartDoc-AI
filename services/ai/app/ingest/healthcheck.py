"""Container healthcheck for the worker: healthy if the heartbeat is fresh."""

import sys
import time

from app.ingest.worker import HEARTBEAT_FILE

MAX_AGE_S = 30.0


def main() -> int:
    try:
        age = time.time() - HEARTBEAT_FILE.stat().st_mtime
    except FileNotFoundError:
        return 1
    return 0 if age <= MAX_AGE_S else 1


if __name__ == "__main__":
    sys.exit(main())
