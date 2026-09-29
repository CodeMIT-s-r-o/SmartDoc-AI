from app.rag.breaker import CircuitBreaker


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_opens_after_repeated_failures_and_recovers_after_the_open_period() -> None:
    clock = Clock()
    breaker = CircuitBreaker(failures=3, window_s=60, open_s=30, clock=clock)

    for _ in range(2):
        breaker.record_failure()
    assert breaker.allow()
    breaker.record_failure()
    assert not breaker.allow()

    clock.now += 31
    assert breaker.allow()


def test_failures_outside_the_window_do_not_count() -> None:
    clock = Clock()
    breaker = CircuitBreaker(failures=3, window_s=60, open_s=30, clock=clock)
    breaker.record_failure()
    breaker.record_failure()
    clock.now += 61
    breaker.record_failure()
    assert breaker.allow()


def test_a_success_resets_the_count() -> None:
    breaker = CircuitBreaker(failures=2, window_s=60, open_s=30, clock=Clock())
    breaker.record_failure()
    breaker.record_success()
    breaker.record_failure()
    assert breaker.allow()
