import { pythonIntegrations } from "./integrations/python.js";
import { pythonRuntimeModules } from "./modules/python.js";
import { pythonProviders } from "./providers/python.js";
import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum
from random import random
from time import monotonic
from typing import Any, Callable, Generic, Mapping, Protocol, Sequence, TypeVar


T = TypeVar("T")


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
    input_tokens: int
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


@dataclass(frozen=True)
class ModelSuccess(Generic[T]):
    value: T
    usage: Usage


ModelResult = ModelSuccess[T] | ModelFailure


class ModelAdapter(Protocol):
    async def invoke(self, request: ModelRequest) -> ModelResult[Any]: ...


class EventSink(Protocol):
    async def emit(self, event: Mapping[str, Any]) -> None: ...


class Guard(Protocol):
    async def check(self, context: GuardContext) -> GuardDecision: ...


class CachePort(Protocol):
    async def get(self, key: str) -> Any | None: ...
    async def set(self, key: str, value: Any) -> None: ...


class ApprovalPort(Protocol):
    async def approve(self, request: ModelRequest, reason: str) -> bool: ...


class EvaluationPort(Protocol):
    async def record(self, request: ModelRequest, result: ModelResult[Any]) -> None: ...


class HumanFeedbackPort(Protocol):
    async def record(self, request_id: str, score: float, note: str | None = None) -> None: ...


class GuardStage(str, Enum):
    INPUT = "input"
    OUTPUT = "output"
    TOOL = "tool"


@dataclass(frozen=True)
class GuardContext:
    stage: GuardStage
    request: ModelRequest
    value: Any


@dataclass(frozen=True)
class GuardAllowed:
    allowed: bool = True


@dataclass(frozen=True)
class GuardRejected:
    reason: str
    allowed: bool = False


GuardDecision = GuardAllowed | GuardRejected


@dataclass(frozen=True)
class ValidationSuccess(Generic[T]):
    value: T


@dataclass(frozen=True)
class ValidationFailure:
    reason: str


ValidationResult = ValidationSuccess[T] | ValidationFailure


class OutputValidator(Protocol, Generic[T]):
    def validate(self, value: Any) -> ValidationResult[T]: ...


class RepairPort(Protocol):
    async def repair(self, request: ModelRequest, invalid_value: Any, reason: str) -> Any: ...


@dataclass(frozen=True)
class RetryOptions:
    max_attempts: int
    base_delay_ms: int
    max_delay_ms: int
    jitter_ratio: float


@dataclass(frozen=True)
class RuntimeOptions:
    timeout_ms: int
    retry: RetryOptions
    fallback_routes: Sequence[str]
    max_repair_attempts: int
    max_input_tokens: int
    max_output_tokens: int
    max_concurrency: int
    max_batch_size: int
    circuit_failure_threshold: int
    circuit_reset_after_seconds: float
    max_estimated_cost_usd: float | None = None


@dataclass(frozen=True)
class ExecuteOptions(Generic[T]):
    validator: OutputValidator[T] | None = None
    cache_key: str | None = None
    approval_reason: str | None = None


class AdapterRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, ModelAdapter] = {}

    def register(self, route: str, adapter: ModelAdapter) -> AdapterRegistry:
        if not route.strip():
            raise ValueError("route must not be empty")
        if route in self._adapters:
            raise ValueError("adapter already registered for route " + route)
        self._adapters[route] = adapter
        return self

    def get(self, route: str) -> ModelAdapter | None:
        return self._adapters.get(route)


class GuardRegistry:
    def __init__(self) -> None:
        self._guards: dict[GuardStage, list[Guard]] = {}

    def register(self, stage: GuardStage, guard: Guard) -> GuardRegistry:
        self._guards.setdefault(stage, []).append(guard)
        return self

    async def check(self, context: GuardContext) -> GuardDecision:
        for guard in self._guards.get(context.stage, []):
            decision = await guard.check(context)
            if isinstance(decision, GuardRejected):
                return decision
        return GuardAllowed()


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


class HarnessRuntime:
    def __init__(
        self,
        options: RuntimeOptions,
        adapters: AdapterRegistry,
        *,
        guards: GuardRegistry | None = None,
        events: EventSink | None = None,
        cache: CachePort | None = None,
        approval: ApprovalPort | None = None,
        evaluation: EvaluationPort | None = None,
        repair: RepairPort | None = None,
        clock: Callable[[], float] = monotonic,
        random_value: Callable[[], float] = random,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        if options.timeout_ms < 1 or options.retry.max_attempts < 1:
            raise ValueError("timeout and max attempts must be positive")
        if options.max_concurrency < 1 or options.max_batch_size < 1:
            raise ValueError("concurrency and batch limits must be positive")
        self.options = options
        self.adapters = adapters
        self.guards = guards
        self.events = events
        self.cache = cache
        self.approval = approval
        self.evaluation = evaluation
        self.repair = repair
        self._clock = clock
        self._random = random_value
        self._sleep = sleep
        self._gate = asyncio.Semaphore(options.max_concurrency)
        self._circuits: dict[str, CircuitBreaker] = {}

    async def execute(
        self, request: ModelRequest, execute_options: ExecuteOptions[T] | None = None
    ) -> ModelResult[T]:
        selected = execute_options or ExecuteOptions[T]()
        try:
            async with self._gate:
                return await self._execute_with_capacity(request, selected)
        except asyncio.CancelledError:
            return ModelFailure(FailureKind.CANCELLED, "The request was cancelled.", False)

    async def execute_batch(
        self, requests: Sequence[ModelRequest], execute_options: ExecuteOptions[T] | None = None
    ) -> Sequence[ModelResult[T]]:
        if len(requests) > self.options.max_batch_size:
            raise ValueError("batch exceeds max_batch_size")
        return await asyncio.gather(*(self.execute(request, execute_options) for request in requests))

    async def _execute_with_capacity(
        self, request: ModelRequest, execute_options: ExecuteOptions[T]
    ) -> ModelResult[T]:
        started_at = self._clock()
        await self._emit("request-started", request)
        budget_failure = enforce_budget(
            request,
            request.input_tokens,
            self.options.max_input_tokens,
            self.options.max_output_tokens,
        )
        if budget_failure is not None:
            return await self._finish_failure(request, budget_failure)

        if self.guards is not None:
            try:
                decision = await self.guards.check(
                    GuardContext(GuardStage.INPUT, request, request.input)
                )
            except Exception:
                return await self._finish_failure(
                    request,
                    ModelFailure(
                        FailureKind.GUARD_REJECTED,
                        "Input guard evaluation failed.",
                        False,
                    ),
                )
            if isinstance(decision, GuardRejected):
                return await self._finish_failure(
                    request,
                    ModelFailure(FailureKind.GUARD_REJECTED, decision.reason, False),
                )

        if execute_options.approval_reason is not None:
            try:
                approved = self.approval is not None and await self.approval.approve(
                    request, execute_options.approval_reason
                )
            except Exception:
                approved = False
            if not approved:
                return await self._finish_failure(
                    request,
                    ModelFailure(
                        FailureKind.APPROVAL_REQUIRED,
                        "The configured human approval was not granted.",
                        False,
                    ),
                )

        if execute_options.cache_key is not None and self.cache is not None:
            try:
                cached = await self.cache.get(execute_options.cache_key)
                if cached is not None:
                    await self._emit("cache-hit", request)
                    result = ModelSuccess(
                        cached,
                        Usage(input_tokens=0, output_tokens=0, estimated_cost_usd=0),
                    )
                    await self._record(request, result)
                    return result
                await self._emit("cache-miss", request)
            except Exception:
                await self._emit("cache-read-failed", request)

        routes = list(dict.fromkeys([request.route, *self.options.fallback_routes]))
        final_failure = ModelFailure(
            FailureKind.PROVIDER,
            "No registered route could complete the request.",
            False,
        )
        for route_index, route in enumerate(routes):
            if route_index > 0:
                await self._emit("fallback-selected", request, route=route)
            adapter = self.adapters.get(route)
            if adapter is None:
                final_failure = ModelFailure(
                    FailureKind.PROVIDER,
                    "No adapter is registered for route " + route + ".",
                    False,
                )
                continue
            circuit = self._circuit(route)
            if not circuit.allow(self._clock()):
                final_failure = ModelFailure(
                    FailureKind.CIRCUIT_OPEN,
                    "The circuit is open for route " + route + ".",
                    True,
                )
                continue

            for attempt in range(1, self.options.retry.max_attempts + 1):
                await self._emit("attempt-started", request, route=route, attempt=attempt)
                result = await self._invoke(adapter, request)
                if isinstance(result, ModelSuccess):
                    resolved = await self._validate_and_repair(
                        request, result.value, execute_options.validator
                    )
                    if isinstance(resolved, ModelFailure):
                        final_failure = resolved
                        break
                    if self.guards is not None:
                        try:
                            decision = await self.guards.check(
                                GuardContext(GuardStage.OUTPUT, request, resolved)
                            )
                        except Exception:
                            return await self._finish_failure(
                                request,
                                ModelFailure(
                                    FailureKind.GUARD_REJECTED,
                                    "Output guard evaluation failed.",
                                    False,
                                ),
                            )
                        if isinstance(decision, GuardRejected):
                            return await self._finish_failure(
                                request,
                                ModelFailure(FailureKind.GUARD_REJECTED, decision.reason, False),
                            )
                    if (
                        self.options.max_estimated_cost_usd is not None
                        and result.usage.estimated_cost_usd
                        > self.options.max_estimated_cost_usd
                    ):
                        return await self._finish_failure(
                            request,
                            ModelFailure(
                                FailureKind.BUDGET_EXHAUSTED,
                                "The result exceeds its configured cost budget.",
                                False,
                            ),
                        )
                    circuit.success()
                    success = ModelSuccess(resolved, result.usage)
                    if execute_options.cache_key is not None and self.cache is not None:
                        try:
                            await self.cache.set(execute_options.cache_key, resolved)
                            await self._emit("cache-stored", request)
                        except Exception:
                            await self._emit("cache-write-failed", request)
                    await self._emit(
                        "request-succeeded",
                        request,
                        usage=result.usage,
                        latency_ms=max(0, round((self._clock() - started_at) * 1000)),
                    )
                    await self._record(request, success)
                    return success

                final_failure = result
                if result.retryable:
                    circuit.failure(self._clock())
                if not result.retryable or attempt >= self.options.retry.max_attempts:
                    break
                delay_ms = retry_delay_ms(
                    attempt,
                    self.options.retry.base_delay_ms,
                    self.options.retry.max_delay_ms,
                    self.options.retry.jitter_ratio,
                    self._random,
                )
                await self._emit(
                    "retry-scheduled", request, delay_ms=delay_ms, attempt=attempt
                )
                await self._sleep(delay_ms / 1000)

            if final_failure.kind in {
                FailureKind.CANCELLED,
                FailureKind.GUARD_REJECTED,
                FailureKind.APPROVAL_REQUIRED,
                FailureKind.BUDGET_EXHAUSTED,
            }:
                return await self._finish_failure(request, final_failure)

        return await self._finish_failure(request, final_failure)

    async def _invoke(
        self, adapter: ModelAdapter, request: ModelRequest
    ) -> ModelResult[Any]:
        try:
            async with asyncio.timeout(self.options.timeout_ms / 1000):
                return await adapter.invoke(request)
        except TimeoutError:
            return ModelFailure(
                FailureKind.TIMEOUT, "The model deadline expired.", True
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return ModelFailure(FailureKind.PROVIDER, str(error), True)

    async def _validate_and_repair(
        self,
        request: ModelRequest,
        initial_value: Any,
        validator: OutputValidator[T] | None,
    ) -> T | ModelFailure:
        if validator is None:
            return initial_value
        candidate = initial_value
        for repair_attempt in range(self.options.max_repair_attempts + 1):
            validation = validator.validate(candidate)
            if isinstance(validation, ValidationSuccess):
                return validation.value
            if repair_attempt >= self.options.max_repair_attempts or self.repair is None:
                return ModelFailure(FailureKind.INVALID_OUTPUT, validation.reason, False)
            try:
                candidate = await self.repair.repair(
                    request, candidate, validation.reason
                )
            except Exception as error:
                return ModelFailure(FailureKind.INVALID_OUTPUT, str(error), False)
        return ModelFailure(
            FailureKind.INVALID_OUTPUT,
            "Structured output could not be validated.",
            False,
        )

    def _circuit(self, route: str) -> CircuitBreaker:
        circuit = self._circuits.get(route)
        if circuit is None:
            circuit = CircuitBreaker(
                self.options.circuit_failure_threshold,
                self.options.circuit_reset_after_seconds,
            )
            self._circuits[route] = circuit
        return circuit

    async def _finish_failure(
        self, request: ModelRequest, failure: ModelFailure
    ) -> ModelFailure:
        await self._emit("request-failed", request, failure_kind=failure.kind.value)
        await self._record(request, failure)
        return failure

    async def _record(self, request: ModelRequest, result: ModelResult[Any]) -> None:
        if self.evaluation is None:
            return
        try:
            await self.evaluation.record(request, result)
        except Exception:
            pass

    async def _emit(self, event_type: str, request: ModelRequest, **details: Any) -> None:
        if self.events is None:
            return
        event = {
            "type": event_type,
            "request_id": request.request_id,
            "occurred_at": self._clock(),
            "prompt_version": request.prompt_version,
            "metadata_keys": sorted(request.metadata.keys()),
            **details,
        }
        try:
            await self.events.emit(event)
        except Exception:
            pass
`;

const TEST_SOURCE = `import asyncio
import unittest

from runtime import (
    AdapterRegistry,
    CircuitBreaker,
    CircuitState,
    ExecuteOptions,
    FailureKind,
    GuardRegistry,
    GuardRejected,
    GuardStage,
    HarnessRuntime,
    ModelFailure,
    ModelRequest,
    ModelSuccess,
    RetryOptions,
    RuntimeOptions,
    Usage,
    ValidationFailure,
    ValidationSuccess,
    enforce_budget,
    retry_delay_ms,
)


class RuntimePrimitivesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.request = ModelRequest("request-1", "primary", "v1", {}, 10, 100, {})

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


class RuntimeFacadeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.request = ModelRequest(
            "request-1", "primary", "v1", {}, 10, 100, {"tenant": "secret-value"}
        )
        self.options = RuntimeOptions(
            timeout_ms=1_000,
            retry=RetryOptions(2, 10, 100, 0),
            fallback_routes=["fallback"],
            max_repair_attempts=1,
            max_input_tokens=100,
            max_output_tokens=100,
            max_concurrency=2,
            max_batch_size=4,
            circuit_failure_threshold=3,
            circuit_reset_after_seconds=1,
        )

    async def test_retry_fallback_repair_and_redacted_events(self) -> None:
        events = []
        delays = []

        class Primary:
            calls = 0

            async def invoke(inner_self, request):
                inner_self.calls += 1
                return ModelFailure(FailureKind.RATE_LIMIT, "busy", True)

        class Fallback:
            async def invoke(self, request):
                return ModelSuccess({"answer": 42}, Usage(10, 2, 0.01))

        class Validator:
            def validate(self, value):
                answer = value.get("answer")
                if isinstance(answer, str):
                    return ValidationSuccess({"answer": answer})
                return ValidationFailure("answer must be a string")

        class Repair:
            async def repair(self, request, value, reason):
                return {"answer": str(value["answer"])}

        class Events:
            async def emit(self, event):
                events.append(event)

        primary = Primary()

        async def sleep(delay):
            delays.append(delay)

        runtime = HarnessRuntime(
            self.options,
            AdapterRegistry().register("primary", primary).register("fallback", Fallback()),
            events=Events(),
            repair=Repair(),
            clock=lambda: 1,
            random_value=lambda: 0,
            sleep=sleep,
        )
        result = await runtime.execute(
            self.request, ExecuteOptions(validator=Validator())
        )
        self.assertIsInstance(result, ModelSuccess)
        self.assertEqual(result.value, {"answer": "42"})
        self.assertEqual(primary.calls, 2)
        self.assertEqual(delays, [0.01])
        self.assertTrue(any(event["type"] == "fallback-selected" for event in events))
        self.assertEqual(events[0]["metadata_keys"], ["tenant"])
        self.assertNotIn("input", events[0])

    async def test_terminal_policy_failures_never_fall_through_to_fallbacks(self) -> None:
        class Adapter:
            async def invoke(self, request):
                return ModelFailure(FailureKind.CANCELLED, "cancelled", False)

        result = await HarnessRuntime(
            self.options, AdapterRegistry().register("primary", Adapter())
        ).execute(self.request)
        self.assertIsInstance(result, ModelFailure)
        self.assertEqual(result.kind, FailureKind.CANCELLED)

    async def test_deadline_and_caller_cancellation_remain_distinct(self) -> None:
        class SlowAdapter:
            async def invoke(self, request):
                await asyncio.sleep(60)
                return ModelSuccess("late", Usage(1, 1, 0))

        options = RuntimeOptions(
            **{
                **self.options.__dict__,
                "timeout_ms": 1,
                "retry": RetryOptions(1, 1, 1, 0),
                "fallback_routes": [],
            }
        )
        runtime = HarnessRuntime(
            options, AdapterRegistry().register("primary", SlowAdapter())
        )
        timed_out = await runtime.execute(self.request)
        self.assertIsInstance(timed_out, ModelFailure)
        self.assertEqual(timed_out.kind, FailureKind.TIMEOUT)

        task = asyncio.create_task(runtime.execute(self.request))
        await asyncio.sleep(0)
        task.cancel()
        cancelled = await task
        self.assertIsInstance(cancelled, ModelFailure)
        self.assertEqual(cancelled.kind, FailureKind.CANCELLED)

    async def test_guards_and_approval_fail_closed(self) -> None:
        calls = 0

        class Adapter:
            async def invoke(self, request):
                nonlocal calls
                calls += 1
                return ModelSuccess("unsafe", Usage(1, 1, 0))

        class RejectGuard:
            async def check(self, context):
                return GuardRejected("blocked by policy")

        adapters = AdapterRegistry().register("primary", Adapter())
        guards = GuardRegistry().register(GuardStage.INPUT, RejectGuard())
        guarded = await HarnessRuntime(self.options, adapters, guards=guards).execute(
            self.request
        )
        self.assertEqual(guarded.kind, FailureKind.GUARD_REJECTED)
        approval = await HarnessRuntime(self.options, adapters).execute(
            self.request, ExecuteOptions(approval_reason="external side effect")
        )
        self.assertEqual(approval.kind, FailureKind.APPROVAL_REQUIRED)
        self.assertEqual(calls, 0)

    async def test_cache_and_batch_concurrency_are_bounded(self) -> None:
        active = 0
        maximum_active = 0
        calls = 0
        values = {}

        class Adapter:
            async def invoke(self, request):
                nonlocal active, maximum_active, calls
                calls += 1
                active += 1
                maximum_active = max(maximum_active, active)
                await asyncio.sleep(0)
                active -= 1
                return ModelSuccess("fresh", Usage(1, 1, 0))

        class Cache:
            async def get(self, key):
                return values.get(key)

            async def set(self, key, value):
                values[key] = value

        options = RuntimeOptions(
            **{**self.options.__dict__, "max_concurrency": 1}
        )
        runtime = HarnessRuntime(
            options,
            AdapterRegistry().register("primary", Adapter()),
            cache=Cache(),
        )
        await runtime.execute(self.request, ExecuteOptions(cache_key="one"))
        cached = await runtime.execute(self.request, ExecuteOptions(cache_key="one"))
        self.assertEqual(cached.value, "fresh")
        await runtime.execute_batch(
            [self.request, ModelRequest("request-2", "primary", "v1", {}, 10, 100, {})]
        )
        self.assertEqual(calls, 3)
        self.assertEqual(maximum_active, 1)

    async def test_cache_and_evaluation_failures_are_contained_and_observable(self) -> None:
        events = []

        class Adapter:
            async def invoke(self, request):
                return ModelSuccess("fresh", Usage(1, 1, 0))

        class Cache:
            async def get(self, key):
                raise RuntimeError("cache unavailable")

            async def set(self, key, value):
                raise RuntimeError("cache unavailable")

        class Evaluation:
            async def record(self, request, result):
                raise RuntimeError("evaluation unavailable")

        class Events:
            async def emit(self, event):
                events.append(event)

        runtime = HarnessRuntime(
            self.options,
            AdapterRegistry().register("primary", Adapter()),
            cache=Cache(),
            evaluation=Evaluation(),
            events=Events(),
        )
        result = await runtime.execute(self.request, ExecuteOptions(cache_key="one"))
        self.assertIsInstance(result, ModelSuccess)
        self.assertTrue(any(event["type"] == "cache-read-failed" for event in events))
        self.assertTrue(any(event["type"] == "cache-write-failed" for event in events))

    async def test_deterministic_policy_pressure_stays_bounded_and_redacted(self) -> None:
        active = 0
        maximum_active = 0
        calls = 0
        events = []

        class Adapter:
            async def invoke(inner_self, request):
                nonlocal active, maximum_active, calls
                calls += 1
                active += 1
                maximum_active = max(maximum_active, active)
                await asyncio.sleep(0)
                active -= 1
                return ModelSuccess("ok", Usage(1, 1, 0.001))

        class Events:
            async def emit(self, event):
                events.append(event)

        pressure_options = RuntimeOptions(
            timeout_ms=1_000,
            retry=RetryOptions(1, 1, 1, 0),
            fallback_routes=[],
            max_repair_attempts=0,
            max_input_tokens=100,
            max_output_tokens=100,
            max_concurrency=4,
            max_batch_size=32,
            circuit_failure_threshold=2,
            circuit_reset_after_seconds=1,
        )
        requests = [
            ModelRequest(
                f"pressure-{index}",
                "primary",
                "v1",
                {},
                10,
                100,
                {"tenant": "public", "apiKey": "secret-value"},
            )
            for index in range(32)
        ]
        runtime = HarnessRuntime(
            pressure_options,
            AdapterRegistry().register("primary", Adapter()),
            events=Events(),
        )
        rounds = 8
        results = []
        for _round in range(rounds):
            results.extend(await runtime.execute_batch(requests))
        total_requests = len(requests) * rounds
        self.assertEqual(len(results), total_requests)
        self.assertTrue(all(isinstance(result, ModelSuccess) for result in results))
        self.assertEqual(calls, total_requests)
        self.assertEqual(maximum_active, 4)
        self.assertEqual(
            sum(event["type"] == "request-started" for event in events), total_requests
        )
        self.assertEqual(
            sum(event["type"] == "attempt-started" for event in events), total_requests
        )
        self.assertEqual(
            sum(event["type"] == "request-succeeded" for event in events), total_requests
        )
        self.assertNotIn("secret-value", repr(events))

        class ExpensiveAdapter:
            async def invoke(self, request):
                return ModelSuccess("too-expensive", Usage(1, 1, 0.01))

        budget_runtime = HarnessRuntime(
            RuntimeOptions(
                **{
                    **pressure_options.__dict__,
                    "max_estimated_cost_usd": 0.0001,
                }
            ),
            AdapterRegistry().register("primary", ExpensiveAdapter()),
        )
        budget_results = await budget_runtime.execute_batch(requests)
        self.assertTrue(
            all(
                isinstance(result, ModelFailure)
                and result.kind is FailureKind.BUDGET_EXHAUSTED
                for result in budget_results
            )
        )

        now = [0.0]
        failing_calls = 0

        class FailingAdapter:
            async def invoke(self, request):
                nonlocal failing_calls
                failing_calls += 1
                return ModelFailure(FailureKind.RATE_LIMIT, "busy", True)

        storm_options = RuntimeOptions(
            **{
                **pressure_options.__dict__,
                "circuit_failure_threshold": 2,
                "circuit_reset_after_seconds": 1,
            }
        )
        storm_runtime = HarnessRuntime(
            storm_options,
            AdapterRegistry().register("primary", FailingAdapter()),
            clock=lambda: now[0],
            sleep=lambda _delay: asyncio.sleep(0),
        )
        first = await storm_runtime.execute(requests[0])
        second = await storm_runtime.execute(requests[1])
        third = await storm_runtime.execute(requests[2])
        self.assertIsInstance(first, ModelFailure)
        self.assertEqual(first.kind, FailureKind.RATE_LIMIT)
        self.assertIsInstance(second, ModelFailure)
        self.assertEqual(second.kind, FailureKind.RATE_LIMIT)
        self.assertIsInstance(third, ModelFailure)
        self.assertEqual(third.kind, FailureKind.CIRCUIT_OPEN)
        self.assertEqual(failing_calls, 2)
        now[0] = 1.0
        half_open = await storm_runtime.execute(requests[3])
        self.assertIsInstance(half_open, ModelFailure)
        self.assertEqual(half_open.kind, FailureKind.RATE_LIMIT)
        self.assertEqual(failing_calls, 3)


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
  testSource: TEST_SOURCE,
  modules: pythonRuntimeModules,
  integrations: pythonIntegrations,
  providers: pythonProviders
});

export function createPythonRuntimeLoader() {
  return runtimeLoader(pythonRuntime);
}

export const pythonRuntimeLoader = createPythonRuntimeLoader();
