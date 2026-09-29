"""In-process circuit breaker for OpenAI: after repeated failures, stop calling for a while.

While it is open the chat answers in degraded mode (the retrieved passages, no generated text) at
no cost, instead of making every user wait for timeouts.
"""

import time
from collections import deque
from collections.abc import Callable


class CircuitBreaker:
    def __init__(
        self,
        failures: int,
        window_s: float,
        open_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._threshold = failures
        self._window = window_s
        self._open_for = open_s
        self._clock = clock
        self._failures: deque[float] = deque()
        self._open_until = 0.0

    @property
    def is_open(self) -> bool:
        return self._clock() < self._open_until

    def allow(self) -> bool:
        """After the open period one trial call goes through (half-open)."""
        return not self.is_open

    def record_success(self) -> None:
        self._failures.clear()

    def record_failure(self) -> None:
        now = self._clock()
        self._failures.append(now)
        while self._failures and now - self._failures[0] > self._window:
            self._failures.popleft()
        if len(self._failures) >= self._threshold:
            self._open_until = now + self._open_for
            self._failures.clear()
