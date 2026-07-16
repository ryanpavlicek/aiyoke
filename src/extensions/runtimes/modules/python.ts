import type { RuntimeModuleDefinition } from "../shared.js";

const tooling = `from __future__ import annotations

import asyncio
from dataclasses import dataclass
from time import monotonic
from typing import Any, Awaitable, Callable, Generic, Mapping, Protocol, TypeVar
import re

from runtime import ModelRequest


I = TypeVar("I")
O = TypeVar("O")
_NAME = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class Valid(Generic[I]):
    value: I


@dataclass(frozen=True)
class Invalid:
    code: str


Validation = Valid[I] | Invalid


@dataclass(frozen=True)
class NoApproval:
    kind: str = "none"


@dataclass(frozen=True)
class ApprovalRequired:
    reason: str
    kind: str = "required"


ApprovalPolicy = NoApproval | ApprovalRequired


@dataclass(frozen=True)
class UncheckedOutput:
    kind: str = "unchecked"


@dataclass(frozen=True)
class ValidatedOutput(Generic[O]):
    validate: Callable[[Any], Validation[O]]
    kind: str = "validate"


OutputPolicy = UncheckedOutput | ValidatedOutput[O]


@dataclass(frozen=True)
class ToolInvocationContext:
    request_id: str
    correlation: ModelRequest | None = None


@dataclass(frozen=True)
class ToolDefinition(Generic[I, O]):
    name: str
    description: str
    approval: ApprovalPolicy
    output: OutputPolicy[O]
    validate_input: Callable[[Any], Validation[I]]
    invoke: Callable[[I, ToolInvocationContext], Awaitable[O]]


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition[Any, Any]] = {}

    def register(self, definition: ToolDefinition[Any, Any]) -> ToolRegistry:
        if not _NAME.fullmatch(definition.name):
            raise ValueError("tool name is invalid")
        if not definition.description.strip():
            raise ValueError("tool description must not be empty")
        if definition.name in self._tools:
            raise ValueError("tool already registered: " + definition.name)
        if isinstance(definition.approval, ApprovalRequired) and not definition.approval.reason.strip():
            raise ValueError("approval reason must not be empty")
        self._tools[definition.name] = definition
        return self

    def get(self, name: str) -> ToolDefinition[Any, Any] | None:
        return self._tools.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))


@dataclass(frozen=True)
class ToolExecutionRequest:
    request_id: str
    tool: str
    input: Any
    metadata: Mapping[str, str]
    timeout_seconds: float | None = None
    correlation: ModelRequest | None = None


@dataclass(frozen=True)
class ToolApprovalRequest:
    request_id: str
    tool: str
    metadata_keys: tuple[str, ...]
    correlation_id: str | None


class ToolApprovalPort(Protocol):
    async def approve(self, request: ToolApprovalRequest, reason: str) -> bool: ...


@dataclass(frozen=True)
class ToolEvent:
    event_type: str
    request_id: str
    tool: str
    occurred_at: float
    metadata_keys: tuple[str, ...]
    correlation_id: str | None


class ToolEventSink(Protocol):
    async def emit(self, event: ToolEvent) -> None: ...


@dataclass(frozen=True)
class ToolSuccess:
    value: Any
    duration_seconds: float


@dataclass(frozen=True)
class ToolFailure:
    kind: str
    phase: str
    message: str
    code: str | None = None
    retryable: bool = False


ToolResult = ToolSuccess | ToolFailure


class ToolRunner:
    def __init__(
        self,
        registry: ToolRegistry,
        default_timeout_seconds: float,
        max_timeout_seconds: float,
        approval: ToolApprovalPort | None = None,
        events: ToolEventSink | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if default_timeout_seconds <= 0:
            raise ValueError("default timeout must be positive")
        if max_timeout_seconds < default_timeout_seconds:
            raise ValueError("maximum timeout must be at least the default")
        self.registry = registry
        self.default_timeout_seconds = default_timeout_seconds
        self.max_timeout_seconds = max_timeout_seconds
        self.approval = approval
        self.events = events
        self.clock = clock

    async def _emit(self, request: ToolExecutionRequest, event_type: str) -> None:
        if self.events is None:
            return
        try:
            await self.events.emit(
                ToolEvent(
                    event_type,
                    request.request_id,
                    request.tool,
                    self.clock(),
                    tuple(sorted(request.metadata)),
                    request.correlation.request_id if request.correlation is not None else None,
                )
            )
        except Exception:
            pass

    async def _failure(self, request: ToolExecutionRequest, failure: ToolFailure) -> ToolFailure:
        await self._emit(request, "tool-failed")
        return failure

    async def execute(self, request: ToolExecutionRequest) -> ToolResult:
        started = self.clock()
        await self._emit(request, "tool-started")
        tool = self.registry.get(request.tool)
        if tool is None:
            return await self._failure(
                request, ToolFailure("not-found", "lookup", "The tool is not registered.")
            )
        try:
            validated_input = tool.validate_input(request.input)
        except Exception:
            validated_input = Invalid("validator_error")
        if isinstance(validated_input, Invalid):
            code = validated_input.code if _NAME.fullmatch(validated_input.code) else "validation_failed"
            return await self._failure(
                request,
                ToolFailure("invalid-input", "input", "Tool input validation failed.", code),
            )
        if isinstance(tool.approval, ApprovalRequired):
            await self._emit(request, "approval-requested")
            if self.approval is None:
                return await self._failure(
                    request,
                    ToolFailure("approval-required", "approval", "A tool approval port is required."),
                )
            approval_request = ToolApprovalRequest(
                request.request_id,
                request.tool,
                tuple(sorted(request.metadata)),
                request.correlation.request_id if request.correlation is not None else None,
            )
            try:
                approved = await self.approval.approve(approval_request, tool.approval.reason)
            except Exception:
                return await self._failure(
                    request,
                    ToolFailure(
                        "approval-failed", "approval", "The approval decision could not be obtained."
                    ),
                )
            if not approved:
                return await self._failure(
                    request,
                    ToolFailure("approval-denied", "approval", "The tool execution was not approved."),
                )
        requested_timeout = request.timeout_seconds or self.default_timeout_seconds
        timeout = min(max(requested_timeout, 0.001), self.max_timeout_seconds)
        task = asyncio.create_task(
            tool.invoke(
                validated_input.value,
                ToolInvocationContext(request.request_id, request.correlation),
            )
        )
        try:
            done, _ = await asyncio.wait({task}, timeout=timeout)
        except asyncio.CancelledError:
            task.cancel()
            return await self._failure(
                request, ToolFailure("cancelled", "execution", "The tool execution was cancelled.")
            )
        if not done:
            task.cancel()
            task.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
            return await self._failure(
                request, ToolFailure("timeout", "execution", "The tool execution deadline expired.")
            )
        try:
            output = task.result()
        except Exception:
            return await self._failure(
                request, ToolFailure("handler-error", "execution", "The tool handler failed.")
            )
        if isinstance(tool.output, ValidatedOutput):
            try:
                validated_output = tool.output.validate(output)
            except Exception:
                validated_output = Invalid("validator_error")
            if isinstance(validated_output, Invalid):
                code = (
                    validated_output.code
                    if _NAME.fullmatch(validated_output.code)
                    else "validation_failed"
                )
                return await self._failure(
                    request,
                    ToolFailure("invalid-output", "output", "Tool output validation failed.", code),
                )
        await self._emit(request, "tool-succeeded")
        return ToolSuccess(output, self.clock() - started)
`;

const toolingTests = `import asyncio
import unittest

from modules.tooling import (
    ApprovalRequired,
    Invalid,
    NoApproval,
    ToolDefinition,
    ToolExecutionRequest,
    ToolFailure,
    ToolRegistry,
    ToolRunner,
    ToolSuccess,
    Valid,
    ValidatedOutput,
)


def number_tool(**overrides):
    async def invoke(value, context):
        return value * 2

    values = {
        "name": "math.double",
        "description": "Doubles a number.",
        "approval": NoApproval(),
        "output": ValidatedOutput(
            lambda value: Valid(value) if isinstance(value, int) else Invalid("not_number")
        ),
        "validate_input": lambda value: (
            Valid(value) if isinstance(value, int) else Invalid("not_number")
        ),
        "invoke": invoke,
    }
    values.update(overrides)
    return ToolDefinition(**values)


class EventSink:
    def __init__(self):
        self.events = []

    async def emit(self, event):
        self.events.append(event)


class ToolingTests(unittest.IsolatedAsyncioTestCase):
    request = ToolExecutionRequest(
        "tool-1", "math.double", 3, {"secret": "must-not-be-emitted", "tenant": "one"}
    )

    async def test_executes_without_logging_values(self):
        events = EventSink()
        registry = ToolRegistry().register(number_tool())
        runner = ToolRunner(registry, 0.1, 1.0, events=events, clock=lambda: 10.0)
        result = await runner.execute(self.request)
        self.assertEqual(result, ToolSuccess(6, 0.0))
        self.assertEqual(registry.names(), ("math.double",))
        self.assertNotIn("must-not-be-emitted", repr(events.events))
        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register(number_tool())

    async def test_fails_closed_for_invalid_input_and_output(self):
        calls = 0

        async def invoke(value, context):
            nonlocal calls
            calls += 1
            return 4

        registry = ToolRegistry().register(
            number_tool(output=ValidatedOutput(lambda value: Invalid("rejected")), invoke=invoke)
        )
        runner = ToolRunner(registry, 0.1, 0.1)
        invalid_input = await runner.execute(
            ToolExecutionRequest("tool-1", "math.double", "secret value", {})
        )
        self.assertIsInstance(invalid_input, ToolFailure)
        self.assertEqual(invalid_input.kind, "invalid-input")
        self.assertNotIn("secret value", repr(invalid_input))
        self.assertEqual(calls, 0)
        invalid_output = await runner.execute(self.request)
        self.assertEqual(invalid_output.kind, "invalid-output")

    async def test_approval_and_timeout_fail_closed(self):
        registry = ToolRegistry().register(
            number_tool(approval=ApprovalRequired("Changes external state."))
        )
        missing = await ToolRunner(registry, 0.1, 0.1).execute(self.request)
        self.assertEqual(missing.kind, "approval-required")

        async def slow(value, context):
            await asyncio.sleep(1)
            return value

        slow_registry = ToolRegistry().register(number_tool(invoke=slow))
        timed_out = await ToolRunner(slow_registry, 0.005, 0.005).execute(self.request)
        self.assertEqual(timed_out.kind, "timeout")


if __name__ == "__main__":
    unittest.main()
`;

const evaluation = `from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from inspect import isawaitable
from time import monotonic
from typing import Any, Awaitable, Callable, Generic, Mapping, Protocol, Sequence, TypeVar
import re

from runtime import HumanFeedbackPort, ModelFailure, ModelSuccess


I = TypeVar("I")
O = TypeVar("O")
E = TypeVar("E")
_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class Offline:
    kind: str = "offline"


@dataclass(frozen=True)
class SampledOnline:
    sample_rate: float
    seed: str
    kind: str = "sampled-online"


EvaluationMode = Offline | SampledOnline


@dataclass(frozen=True)
class EvaluationCase(Generic[I, E]):
    case_id: str
    input: I
    expected: E
    route: str
    prompt_version: str
    metadata: Mapping[str, str]


@dataclass(frozen=True)
class EvaluationSuite(Generic[I, E]):
    suite_id: str
    version: str
    evaluator: str
    threshold: float
    mode: EvaluationMode
    model: str
    policy_fingerprint: str
    cases: Sequence[EvaluationCase[I, E]]


@dataclass(frozen=True)
class InvocationContext:
    case_id: str
    route: str
    prompt_version: str
    model: str
    policy_fingerprint: str


class EvaluationSubject(Protocol, Generic[I, O]):
    async def invoke(self, value: I, context: InvocationContext) -> ModelSuccess[O] | ModelFailure: ...


@dataclass(frozen=True)
class Evaluator(Generic[O, E]):
    evaluator_id: str
    score: Callable[[O, E], float | Awaitable[float]]


class EvaluatorRegistry:
    def __init__(self) -> None:
        self._evaluators: dict[str, Evaluator[Any, Any]] = {}

    def register(self, evaluator: Evaluator[Any, Any]) -> EvaluatorRegistry:
        if not _ID.fullmatch(evaluator.evaluator_id):
            raise ValueError("evaluator id is invalid")
        if evaluator.evaluator_id in self._evaluators:
            raise ValueError("evaluator already registered: " + evaluator.evaluator_id)
        self._evaluators[evaluator.evaluator_id] = evaluator
        return self

    def get(self, evaluator_id: str) -> Evaluator[Any, Any] | None:
        return self._evaluators.get(evaluator_id)


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    route: str
    prompt_version: str
    model: str
    policy_fingerprint: str
    metadata_keys: tuple[str, ...]
    duration_seconds: float
    status: str
    score: float | None = None
    failure_kind: str | None = None


@dataclass(frozen=True)
class Delivery:
    kind: str
    code: str | None = None


@dataclass(frozen=True)
class EvaluationReport:
    suite_id: str
    suite_version: str
    evaluator: str
    model: str
    policy_fingerprint: str
    results: tuple[CaseResult, ...]
    executed: int
    passed: int
    failed: int
    skipped: int
    pass_rate: float
    mean_score: float
    delivery: Delivery


class ReportSink(Protocol):
    async def write(self, report: EvaluationReport) -> None: ...


def _hash(value: str) -> int:
    result = 2_166_136_261
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 16_777_619) & 0xFFFFFFFF
    return result


def _sampled(case_id: str, mode: EvaluationMode) -> bool:
    return isinstance(mode, Offline) or _hash(mode.seed + ":" + case_id) / 2**32 < mode.sample_rate


class EvaluationRunner:
    def __init__(
        self,
        max_concurrency: int,
        registry: EvaluatorRegistry,
        report_sink: ReportSink | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if max_concurrency <= 0:
            raise ValueError("max concurrency must be positive")
        self.max_concurrency = max_concurrency
        self.registry = registry
        self.report_sink = report_sink
        self.clock = clock

    async def run(
        self, suite: EvaluationSuite[I, E], subject: EvaluationSubject[I, O]
    ) -> EvaluationReport:
        self._validate(suite)
        evaluator = self.registry.get(suite.evaluator)
        if evaluator is None:
            raise ValueError("evaluator is not registered: " + suite.evaluator)
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def run_case(case: EvaluationCase[I, E]) -> CaseResult:
            if not _sampled(case.case_id, suite.mode):
                return self._metadata(suite, case, 0.0, "skipped")
            async with semaphore:
                started = self.clock()
                context = InvocationContext(
                    case.case_id,
                    case.route,
                    case.prompt_version,
                    suite.model,
                    suite.policy_fingerprint,
                )
                try:
                    result = await subject.invoke(case.input, context)
                except Exception:
                    return self._metadata(
                        suite, case, self.clock() - started, "provider-failure", failure_kind="subject_error"
                    )
                if isinstance(result, ModelFailure):
                    return self._metadata(
                        suite, case, self.clock() - started, "provider-failure", failure_kind=result.kind.value
                    )
                try:
                    score_value = evaluator.score(result.value, case.expected)
                    score = await score_value if isawaitable(score_value) else score_value
                    if not 0 <= score <= 1:
                        raise ValueError("score out of range")
                except Exception:
                    return self._metadata(
                        suite, case, self.clock() - started, "scorer-error", failure_kind="scorer_error"
                    )
                return self._metadata(
                    suite,
                    case,
                    self.clock() - started,
                    "passed" if score >= suite.threshold else "failed",
                    score=score,
                )

        results = tuple(await asyncio.gather(*(run_case(case) for case in suite.cases)))
        executed_results = [result for result in results if result.status != "skipped"]
        scored = [result.score for result in executed_results if result.score is not None]
        passed = sum(result.status == "passed" for result in results)
        base = EvaluationReport(
            suite.suite_id,
            suite.version,
            suite.evaluator,
            suite.model,
            suite.policy_fingerprint,
            results,
            len(executed_results),
            passed,
            len(executed_results) - passed,
            len(results) - len(executed_results),
            passed / len(executed_results) if executed_results else 0.0,
            sum(scored) / len(scored) if scored else 0.0,
            Delivery("not-configured"),
        )
        if self.report_sink is None:
            return base
        try:
            await self.report_sink.write(base)
            delivery = Delivery("stored")
        except Exception:
            delivery = Delivery("failed", "report_sink_error")
        return replace(base, delivery=delivery)

    @staticmethod
    def _metadata(suite, case, duration, status, score=None, failure_kind=None):
        return CaseResult(
            case.case_id,
            case.route,
            case.prompt_version,
            suite.model,
            suite.policy_fingerprint,
            tuple(sorted(case.metadata)),
            duration,
            status,
            score,
            failure_kind,
        )

    @staticmethod
    def _validate(suite) -> None:
        if not _ID.fullmatch(suite.suite_id):
            raise ValueError("suite id is invalid")
        if not suite.version.strip() or not suite.model.strip() or not suite.policy_fingerprint.strip():
            raise ValueError("suite reproducibility metadata must not be empty")
        if not 0 <= suite.threshold <= 1:
            raise ValueError("threshold must be between zero and one")
        if isinstance(suite.mode, SampledOnline) and not 0 <= suite.mode.sample_rate <= 1:
            raise ValueError("sample rate must be between zero and one")
        identifiers: set[str] = set()
        for case in suite.cases:
            if not _ID.fullmatch(case.case_id):
                raise ValueError("case id is invalid")
            if case.case_id in identifiers:
                raise ValueError("duplicate evaluation case: " + case.case_id)
            identifiers.add(case.case_id)


@dataclass(frozen=True)
class Baseline:
    suite_id: str
    suite_version: str
    pass_rate: float
    mean_score: float


@dataclass(frozen=True)
class RegressionDecision:
    kind: str
    pass_rate_drop: float
    mean_score_drop: float
    reasons: tuple[str, ...]


def compare_baseline(report, baseline, max_pass_rate_drop, max_mean_score_drop):
    if report.suite_id != baseline.suite_id:
        raise ValueError("baseline suite id does not match")
    pass_drop = max(0.0, baseline.pass_rate - report.pass_rate)
    score_drop = max(0.0, baseline.mean_score - report.mean_score)
    reasons = tuple(
        reason
        for reason, exceeded in (
            ("pass-rate", pass_drop > max_pass_rate_drop),
            ("mean-score", score_drop > max_mean_score_drop),
        )
        if exceeded
    )
    return RegressionDecision("regressed" if reasons else "accepted", pass_drop, score_drop, reasons)


async def record_human_feedback(
    port: HumanFeedbackPort, request_id: str, score: float, note: str | None = None
) -> None:
    if not -1 <= score <= 1:
        raise ValueError("feedback score must be between minus one and one")
    await port.record(request_id, score, note)
`;

const evaluationTests = `import unittest

from modules.evaluation import (
    Baseline,
    EvaluationCase,
    EvaluationRunner,
    EvaluationSuite,
    Evaluator,
    EvaluatorRegistry,
    Offline,
    SampledOnline,
    compare_baseline,
    record_human_feedback,
)
from runtime import FailureKind, ModelFailure, ModelSuccess, Usage


def make_suite(mode=Offline()):
    return EvaluationSuite(
        "answers",
        "v1",
        "exact",
        1.0,
        mode,
        "test/model",
        "sha256:test",
        (
            EvaluationCase("one", "one", "ONE", "primary", "p1", {}),
            EvaluationCase("two", "two", "TWO", "primary", "p1", {}),
            EvaluationCase("three", "three", "THREE", "fallback", "p1", {}),
        ),
    )


class Subject:
    def __init__(self):
        self.calls = 0
        self.active = 0
        self.maximum = 0

    async def invoke(self, value, context):
        self.calls += 1
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        await __import__("asyncio").sleep(0)
        self.active -= 1
        if value == "three":
            return ModelFailure(FailureKind.PROVIDER, "bad", False)
        return ModelSuccess("ONE" if value == "one" else "wrong", Usage(1, 1, 0))


class Feedback:
    def __init__(self):
        self.values = []

    async def record(self, *values):
        self.values.append(values)


class EvaluationTests(unittest.IsolatedAsyncioTestCase):
    def registry(self):
        return EvaluatorRegistry().register(
            Evaluator("exact", lambda actual, expected: 1.0 if actual == expected else 0.0)
        )

    async def test_runs_offline_with_bounded_concurrency(self):
        subject = Subject()
        report = await EvaluationRunner(2, self.registry(), clock=lambda: 10.0).run(
            make_suite(), subject
        )
        self.assertEqual(subject.maximum, 2)
        self.assertEqual((report.executed, report.passed, report.failed), (3, 1, 2))
        self.assertEqual(
            tuple(result.status for result in report.results),
            ("passed", "failed", "provider-failure"),
        )

    async def test_sampling_baseline_and_feedback(self):
        subject = Subject()
        report = await EvaluationRunner(1, self.registry()).run(
            make_suite(SampledOnline(0.0, "fixed")), subject
        )
        self.assertEqual(subject.calls, 0)
        self.assertEqual(report.skipped, 3)
        decision = compare_baseline(
            report, Baseline("answers", "v0", 0.9, 0.8), 0.1, 0.1
        )
        self.assertEqual(decision.kind, "regressed")
        feedback = Feedback()
        await record_human_feedback(feedback, "request-1", 1.0, "good")
        self.assertEqual(feedback.values, [("request-1", 1.0, "good")])
        with self.assertRaises(ValueError):
            await record_human_feedback(feedback, "request-1", 2.0)

    async def test_rejects_duplicates(self):
        registry = self.registry()
        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register(Evaluator("exact", lambda actual, expected: 1.0))
        suite = make_suite()
        duplicate = EvaluationSuite(
            suite.suite_id,
            suite.version,
            suite.evaluator,
            suite.threshold,
            suite.mode,
            suite.model,
            suite.policy_fingerprint,
            (suite.cases[0], suite.cases[0]),
        )
        with self.assertRaisesRegex(ValueError, "duplicate evaluation case"):
            await EvaluationRunner(1, registry).run(duplicate, Subject())


if __name__ == "__main__":
    unittest.main()
`;

export const pythonRuntimeModules: readonly RuntimeModuleDefinition[] = [
  {
    id: "tooling",
    description: "Registered, guarded, approval-aware tool execution.",
    artifacts: [
      { path: "modules/__init__.py", source: "" },
      { path: "modules/tooling.py", source: tooling },
      { path: "modules/test_tooling.py", source: toolingTests }
    ]
  },
  {
    id: "evaluation",
    description: "Versioned offline and sampled-online evaluation runner.",
    artifacts: [
      { path: "modules/evaluation.py", source: evaluation },
      { path: "modules/test_evaluation.py", source: evaluationTests }
    ]
  }
];
