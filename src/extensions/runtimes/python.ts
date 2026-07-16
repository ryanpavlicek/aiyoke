import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from random import random
from time import monotonic
from typing import Any, Awaitable, Callable, Mapping, Protocol


class FailureKind(str, Enum):
    TIMEOUT = "timeout"
    RATE_LIMIT = "rate-limit"
    PROVIDER = "provider"
    INVALID_OUTPUT = "invalid-output"
    GUARD_REJECTED = "guard-rejected"
    APPROVAL_REQUIRED = "approval-required"
    BUDGET_EXHAUSTED = "budget-exhausted"
    CIRCUIT_OPEN = "circuit-open"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ModelRequest:
    request_id: str
    route: str
    prompt_version: str
    input: Any
    max_output_tokens: int
    metadata: Mapping[str, str]


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float


@dataclass(frozen=True)
class ModelFailure:
    kind: FailureKind
    message: str
    retryable: bool
    provider_code: str | None = None


class ModelAdapter(Protocol):
    async def invoke(self, request: ModelRequest) -> tuple[Any, Usage] | ModelFailure: ...


class EventSink(Protocol):
    async def emit(self, event: Mapping[str, Any]) -> None: ...


class Guard(Protocol):
    async def check(self, request: ModelRequest) -> str | None: ...


class CachePort(Protocol):
    async def get(self, key: str) -> Any | None: ...
    async def set(self, key: str, value: Any) -> None: ...


class ApprovalPort(Protocol):
    async def approve(self, request: ModelRequest, reason: str) -> bool: ...


class EvaluationPort(Protocol):
    async def record(self, request: ModelRequest, result: Any | ModelFailure) -> None: ...


def retry_delay_ms(
    attempt: int,
    base_delay_ms: int,
    max_delay_ms: int,
    jitter_ratio: float,
    random_value: Callable[[], float] = random,
) -> int:
    if attempt < 1:
        raise ValueError("attempt must be positive")
    bounded = min(max_delay_ms, base_delay_ms * (2 ** (attempt - 1)))
    jitter = bounded * jitter_ratio * max(0.0, min(1.0, random_value()))
    return round(bounded + jitter)


def enforce_budget(
    request: ModelRequest,
    input_tokens: int,
    max_input_tokens: int,
    max_output_tokens: int,
) -> ModelFailure | None:
    if input_tokens <= max_input_tokens and request.max_output_tokens <= max_output_tokens:
        return None
    return ModelFailure(
        kind=FailureKind.BUDGET_EXHAUSTED,
        message="The request exceeds its configured token budget.",
        retryable=False,
    )


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half-open"


class CircuitBreaker:
    def __init__(self, failure_threshold: int, reset_after_seconds: float) -> None:
        if failure_threshold < 1 or reset_after_seconds <= 0:
            raise ValueError("circuit breaker limits must be positive")
        self._failure_threshold = failure_threshold
        self._reset_after_seconds = reset_after_seconds
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._opened_at = 0.0

    def state(self, now: float | None = None) -> CircuitState:
        current = monotonic() if now is None else now
        if self._state is CircuitState.OPEN and current - self._opened_at >= self._reset_after_seconds:
            self._state = CircuitState.HALF_OPEN
        return self._state

    def allow(self, now: float | None = None) -> bool:
        return self.state(now) is not CircuitState.OPEN

    def success(self) -> None:
        self._state = CircuitState.CLOSED
        self._failures = 0

    def failure(self, now: float | None = None) -> None:
        current = monotonic() if now is None else now
        self._failures += 1
        if self._state is CircuitState.HALF_OPEN or self._failures >= self._failure_threshold:
            self._state = CircuitState.OPEN
            self._opened_at = current
`;

const TEST_SOURCE = `import unittest

from runtime import (
    CircuitBreaker,
    CircuitState,
    FailureKind,
    ModelRequest,
    enforce_budget,
    retry_delay_ms,
)


class RuntimePrimitivesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.request = ModelRequest("request-1", "primary", "v1", {}, 100, {})

    def test_retry_delay_is_bounded_and_deterministic(self) -> None:
        self.assertEqual(retry_delay_ms(2, 100, 1_000, 0.5, lambda: 0), 200)
        with self.assertRaises(ValueError):
            retry_delay_ms(0, 100, 1_000, 0, lambda: 0)

    def test_token_budget_fails_closed(self) -> None:
        self.assertIsNone(enforce_budget(self.request, 10, 10, 100))
        failure = enforce_budget(self.request, 11, 10, 100)
        self.assertIsNotNone(failure)
        self.assertEqual(failure.kind, FailureKind.BUDGET_EXHAUSTED)

    def test_circuit_transitions(self) -> None:
        breaker = CircuitBreaker(2, 0.1)
        breaker.failure(0.0)
        self.assertTrue(breaker.allow(0.01))
        breaker.failure(0.02)
        self.assertFalse(breaker.allow(0.05))
        self.assertTrue(breaker.allow(0.121))
        self.assertEqual(breaker.state(0.121), CircuitState.HALF_OPEN)
        breaker.success()
        self.assertTrue(breaker.allow(0.13))


if __name__ == "__main__":
    unittest.main()
`;

export const pythonRuntime = createRuntimeTemplate({
  id: "python-runtime",
  language: "python",
  displayName: "Python",
  fileName: "runtime.py",
  source: SOURCE,
  testFileName: "test_runtime.py",
  testSource: TEST_SOURCE
});

export function createPythonRuntimeLoader() {
  return runtimeLoader(pythonRuntime);
}

export const pythonRuntimeLoader = createPythonRuntimeLoader();
