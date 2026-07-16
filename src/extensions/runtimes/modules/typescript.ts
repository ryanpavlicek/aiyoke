import type { RuntimeModuleDefinition } from "../shared.js";

const tooling = `import type { ModelRequest } from "../runtime.js";

export type ToolValidation<T> =
  | { readonly kind: "valid"; readonly value: T }
  | { readonly kind: "invalid"; readonly code: string };

export type ToolApprovalPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "required"; readonly reason: string };

export type ToolOutputPolicy<T> =
  | { readonly kind: "unchecked" }
  | {
      readonly kind: "validate";
      readonly validate: (value: unknown) => ToolValidation<T>;
    };

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly correlation?: Pick<ModelRequest, "id" | "promptVersion">;
}

export interface ToolDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly approval: ToolApprovalPolicy;
  readonly output: ToolOutputPolicy<O>;
  readonly validateInput: (value: unknown) => ToolValidation<I>;
  readonly invoke: (input: I, context: ToolInvocationContext) => Promise<O>;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly approval: ToolApprovalPolicy;
  readonly validateInput: (value: unknown) => ToolValidation<unknown>;
  readonly invoke: (input: unknown, context: ToolInvocationContext) => Promise<unknown>;
  readonly validateOutput?: (value: unknown) => ToolValidation<unknown>;
}

const toolName = /^[a-z][a-z0-9._-]{0,63}$/;
const safeCode = /^[a-z][a-z0-9._-]{0,63}$/;

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register<I, O>(definition: ToolDefinition<I, O>): this {
    if (!toolName.test(definition.name)) throw new TypeError("tool name is invalid");
    if (definition.description.trim().length === 0) {
      throw new TypeError("tool description must not be empty");
    }
    if (this.#tools.has(definition.name)) {
      throw new Error("tool already registered: " + definition.name);
    }
    if (definition.approval.kind === "required" && definition.approval.reason.trim().length === 0) {
      throw new TypeError("approval reason must not be empty");
    }
    const validateOutput =
      definition.output.kind === "validate" ? definition.output.validate : undefined;
    this.#tools.set(definition.name, {
      name: definition.name,
      description: definition.description,
      approval: definition.approval,
      validateInput: (value) => definition.validateInput(value),
      invoke: (input, context) => definition.invoke(input as I, context),
      ...(validateOutput === undefined
        ? {}
        : { validateOutput: (value: unknown) => validateOutput(value) })
    });
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  names(): readonly string[] {
    return [...this.#tools.keys()].sort();
  }
}

export interface ToolExecutionRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly correlation?: Pick<ModelRequest, "id" | "promptVersion">;
}

export type ToolFailureKind =
  | "not-found"
  | "invalid-input"
  | "approval-required"
  | "approval-denied"
  | "approval-failed"
  | "timeout"
  | "cancelled"
  | "handler-error"
  | "invalid-output";

export type ToolFailurePhase = "lookup" | "input" | "approval" | "execution" | "output";

export type ToolExecutionResult<T = unknown> =
  | { readonly kind: "success"; readonly value: T; readonly durationMs: number }
  | {
      readonly kind: "failure";
      readonly failure: {
        readonly kind: ToolFailureKind;
        readonly phase: ToolFailurePhase;
        readonly message: string;
        readonly retryable: false;
        readonly code?: string;
      };
    };

export interface ToolApprovalPort {
  approve(request: Readonly<Omit<ToolExecutionRequest, "input">>, reason: string): Promise<boolean>;
}

export type ToolEvent = Readonly<{
  type: "tool-started" | "approval-requested" | "tool-succeeded" | "tool-failed";
  requestId: string;
  tool: string;
  occurredAt: number;
  metadataKeys: readonly string[];
  correlationId?: string;
}>;

export interface ToolEventSink {
  emit(event: ToolEvent): Promise<void>;
}

export interface ToolRunnerOptions {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
}

export interface ToolRunnerDependencies {
  readonly registry: ToolRegistry;
  readonly approval?: ToolApprovalPort;
  readonly events?: ToolEventSink;
  readonly now?: () => number;
}

function failure(
  kind: ToolFailureKind,
  phase: ToolFailurePhase,
  message: string,
  code?: string
): ToolExecutionResult<never> {
  return {
    kind: "failure",
    failure: {
      kind,
      phase,
      message,
      retryable: false,
      ...(code === undefined ? {} : { code: safeCode.test(code) ? code : "validation_failed" })
    }
  };
}

export class ToolRunner {
  readonly #now: () => number;

  constructor(
    readonly options: ToolRunnerOptions,
    readonly dependencies: ToolRunnerDependencies
  ) {
    if (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0) {
      throw new TypeError("defaultTimeoutMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(options.maxTimeoutMs) ||
      options.maxTimeoutMs < options.defaultTimeoutMs
    ) {
      throw new TypeError("maxTimeoutMs must be a safe integer at least defaultTimeoutMs");
    }
    this.#now = dependencies.now ?? Date.now;
  }

  async #emit(request: ToolExecutionRequest, type: ToolEvent["type"]): Promise<void> {
    try {
      await this.dependencies.events?.emit({
        type,
        requestId: request.requestId,
        tool: request.tool,
        occurredAt: this.#now(),
        metadataKeys: Object.keys(request.metadata).sort(),
        ...(request.correlation === undefined ? {} : { correlationId: request.correlation.id })
      });
    } catch {
      // Telemetry is an integration boundary and must not change tool semantics.
    }
  }

  async #failed(
    request: ToolExecutionRequest,
    result: ToolExecutionResult<never>
  ): Promise<ToolExecutionResult<never>> {
    await this.#emit(request, "tool-failed");
    return result;
  }

  async execute(
    request: ToolExecutionRequest,
    parentSignal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const startedAt = this.#now();
    await this.#emit(request, "tool-started");
    const tool = this.dependencies.registry.get(request.tool);
    if (tool === undefined) {
      return this.#failed(request, failure("not-found", "lookup", "The tool is not registered."));
    }
    let input: ToolValidation<unknown>;
    try {
      input = tool.validateInput(request.input);
    } catch {
      return this.#failed(
        request,
        failure("invalid-input", "input", "Tool input validation failed.", "validator_error")
      );
    }
    if (input.kind === "invalid") {
      return this.#failed(
        request,
        failure("invalid-input", "input", "Tool input validation failed.", input.code)
      );
    }
    if (tool.approval.kind === "required") {
      await this.#emit(request, "approval-requested");
      if (this.dependencies.approval === undefined) {
        return this.#failed(
          request,
          failure("approval-required", "approval", "A tool approval port is required.")
        );
      }
      let approved: boolean;
      try {
        const { input: _input, ...redactedRequest } = request;
        approved = await this.dependencies.approval.approve(redactedRequest, tool.approval.reason);
      } catch {
        return this.#failed(
          request,
          failure("approval-failed", "approval", "The approval decision could not be obtained.")
        );
      }
      if (!approved) {
        return this.#failed(
          request,
          failure("approval-denied", "approval", "The tool execution was not approved.")
        );
      }
    }
    const requestedTimeout = request.timeoutMs ?? this.options.defaultTimeoutMs;
    const timeoutMs = Math.min(Math.max(1, requestedTimeout), this.options.maxTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted === true) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const invocation = Promise.resolve()
      .then(() =>
        tool.invoke(input.value, {
          requestId: request.requestId,
          signal: controller.signal,
          ...(request.correlation === undefined ? {} : { correlation: request.correlation })
        })
      )
      .then(
        (value) => ({ kind: "completed" as const, value }),
        () => ({ kind: "handler-error" as const })
      );
    const aborted = controller.signal.aborted
      ? Promise.resolve({ kind: "aborted" as const })
      : new Promise<{ readonly kind: "aborted" }>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
            once: true
          })
        );
    const outcome = await Promise.race([invocation, aborted]);
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (outcome.kind === "aborted") {
      return this.#failed(
        request,
        timedOut
          ? failure("timeout", "execution", "The tool execution deadline expired.")
          : failure("cancelled", "execution", "The tool execution was cancelled.")
      );
    }
    if (outcome.kind === "handler-error") {
      return this.#failed(
        request,
        failure("handler-error", "execution", "The tool handler failed.")
      );
    }
    if (tool.validateOutput !== undefined) {
      let output: ToolValidation<unknown>;
      try {
        output = tool.validateOutput(outcome.value);
      } catch {
        return this.#failed(
          request,
          failure("invalid-output", "output", "Tool output validation failed.", "validator_error")
        );
      }
      if (output.kind === "invalid") {
        return this.#failed(
          request,
          failure("invalid-output", "output", "Tool output validation failed.", output.code)
        );
      }
    }
    await this.#emit(request, "tool-succeeded");
    return { kind: "success", value: outcome.value, durationMs: this.#now() - startedAt };
  }
}
`;

const toolingTests = `import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, ToolRunner } from "./tooling.js";
import type {
  ToolDefinition,
  ToolEvent,
  ToolExecutionRequest
} from "./tooling.js";

const request: ToolExecutionRequest = {
  requestId: "tool-1",
  tool: "math.double",
  input: 3,
  metadata: { tenant: "one", secret: "must-not-be-emitted" }
};

function numberTool(
  overrides: Partial<ToolDefinition<number, number>> = {}
): ToolDefinition<number, number> {
  return {
    name: "math.double",
    description: "Doubles a number.",
    approval: { kind: "none" as const },
    output: { kind: "validate" as const, validate: (value: unknown) =>
      typeof value === "number" ? { kind: "valid", value } : { kind: "invalid", code: "not_number" }
    },
    validateInput: (value: unknown) =>
      typeof value === "number" ? { kind: "valid", value } : { kind: "invalid", code: "not_number" },
    invoke: async (value: number) => value * 2,
    ...overrides
  };
}

test("registers and executes a validated tool without logging values", async () => {
  const events: ToolEvent[] = [];
  const registry = new ToolRegistry().register(numberTool());
  const runner = new ToolRunner(
    { defaultTimeoutMs: 100, maxTimeoutMs: 1_000 },
    { registry, events: { emit: async (event) => void events.push(event) }, now: () => 10 }
  );
  const result = await runner.execute(request);
  assert.deepEqual(result, { kind: "success", value: 6, durationMs: 0 });
  assert.deepEqual(registry.names(), ["math.double"]);
  assert.equal(JSON.stringify(events).includes("must-not-be-emitted"), false);
  assert.deepEqual(events.map((event) => event.type), ["tool-started", "tool-succeeded"]);
  assert.throws(() => registry.register(numberTool()), /already registered/);
});

test("fails closed for invalid input and output", async () => {
  let calls = 0;
  const registry = new ToolRegistry().register(
    numberTool({
      output: { kind: "validate", validate: () => ({ kind: "invalid", code: "rejected" }) },
      invoke: async () => { calls += 1; return 4; }
    })
  );
  const runner = new ToolRunner({ defaultTimeoutMs: 100, maxTimeoutMs: 100 }, { registry });
  const invalidInput = await runner.execute({ ...request, input: "secret value" });
  assert.equal(invalidInput.kind === "failure" ? invalidInput.failure.kind : "", "invalid-input");
  assert.equal(JSON.stringify(invalidInput).includes("secret value"), false);
  assert.equal(calls, 0);
  const invalidOutput = await runner.execute(request);
  assert.equal(invalidOutput.kind === "failure" ? invalidOutput.failure.kind : "", "invalid-output");
});

test("requires explicit approval and never sends tool input to the approval port", async () => {
  let approvalRequest: Readonly<Omit<ToolExecutionRequest, "input">> | undefined;
  const registry = new ToolRegistry().register(
    numberTool({ approval: { kind: "required", reason: "Changes external state." } })
  );
  const missing = await new ToolRunner(
    { defaultTimeoutMs: 100, maxTimeoutMs: 100 },
    { registry }
  ).execute(request);
  assert.equal(missing.kind === "failure" ? missing.failure.kind : "", "approval-required");
  const denied = await new ToolRunner(
    { defaultTimeoutMs: 100, maxTimeoutMs: 100 },
    { registry, approval: { approve: async (value) => { approvalRequest = value; return false; } } }
  ).execute(request);
  assert.equal(denied.kind === "failure" ? denied.failure.kind : "", "approval-denied");
  assert.ok(approvalRequest !== undefined);
  assert.equal("input" in approvalRequest, false);
});

test("returns on timeout even when a handler ignores cancellation", async () => {
  const registry = new ToolRegistry().register(
    numberTool({ invoke: async () => new Promise(() => undefined) })
  );
  const result = await new ToolRunner(
    { defaultTimeoutMs: 5, maxTimeoutMs: 5 },
    { registry }
  ).execute(request);
  assert.equal(result.kind === "failure" ? result.failure.kind : "", "timeout");
});
`;

const evaluation = `import type { HumanFeedbackPort, ModelResult } from "../runtime.js";

export type EvaluationMode =
  | { readonly kind: "offline" }
  | { readonly kind: "sampled-online"; readonly sampleRate: number; readonly seed: string };

export interface EvaluationCase<I, E> {
  readonly id: string;
  readonly input: I;
  readonly expected: E;
  readonly route: string;
  readonly promptVersion: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface EvaluationSuite<I, E> {
  readonly id: string;
  readonly version: string;
  readonly evaluator: string;
  readonly threshold: number;
  readonly mode: EvaluationMode;
  readonly model: string;
  readonly policyFingerprint: string;
  readonly cases: readonly EvaluationCase<I, E>[];
}

export interface EvaluationInvocationContext {
  readonly caseId: string;
  readonly route: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly policyFingerprint: string;
}

export interface EvaluationSubject<I, O> {
  invoke(
    input: I,
    context: EvaluationInvocationContext,
    signal: AbortSignal
  ): Promise<ModelResult<O>>;
}

export interface EvaluatorDefinition<O, E> {
  readonly id: string;
  score(actual: O, expected: E): Promise<number> | number;
}

interface RegisteredEvaluator {
  readonly id: string;
  score(actual: unknown, expected: unknown): Promise<number>;
}

const identifier = /^[a-z][a-z0-9._-]{0,63}$/;

export class EvaluatorRegistry {
  readonly #evaluators = new Map<string, RegisteredEvaluator>();

  register<O, E>(definition: EvaluatorDefinition<O, E>): this {
    if (!identifier.test(definition.id)) throw new TypeError("evaluator id is invalid");
    if (this.#evaluators.has(definition.id)) {
      throw new Error("evaluator already registered: " + definition.id);
    }
    this.#evaluators.set(definition.id, {
      id: definition.id,
      score: async (actual, expected) => definition.score(actual as O, expected as E)
    });
    return this;
  }

  get(id: string): RegisteredEvaluator | undefined {
    return this.#evaluators.get(id);
  }
}

interface EvaluationCaseMetadata {
  readonly caseId: string;
  readonly route: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly policyFingerprint: string;
  readonly metadataKeys: readonly string[];
  readonly durationMs: number;
}

export type EvaluationCaseResult =
  | (EvaluationCaseMetadata & { readonly status: "passed" | "failed"; readonly score: number })
  | (EvaluationCaseMetadata & {
      readonly status: "provider-failure";
      readonly failureKind: string;
    })
  | (EvaluationCaseMetadata & { readonly status: "scorer-error"; readonly code: "scorer_error" })
  | (EvaluationCaseMetadata & { readonly status: "skipped"; readonly reason: "not-sampled" });

export type EvaluationDelivery =
  | { readonly kind: "not-configured" }
  | { readonly kind: "stored" }
  | { readonly kind: "failed"; readonly code: "report_sink_error" };

export interface EvaluationReport {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly evaluator: string;
  readonly model: string;
  readonly policyFingerprint: string;
  readonly results: readonly EvaluationCaseResult[];
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly passRate: number;
  readonly meanScore: number;
  readonly delivery: EvaluationDelivery;
}

export interface EvaluationReportSink {
  write(report: Omit<EvaluationReport, "delivery">): Promise<void>;
}

export interface EvaluationRunnerOptions {
  readonly maxConcurrency: number;
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function sampled(caseId: string, mode: EvaluationMode): boolean {
  if (mode.kind === "offline") return true;
  return hash(mode.seed + ":" + caseId) / 0x1_0000_0000 < mode.sampleRate;
}

function validateSuite<I, E>(suite: EvaluationSuite<I, E>): void {
  if (!identifier.test(suite.id)) throw new TypeError("suite id is invalid");
  if (suite.version.trim().length === 0) throw new TypeError("suite version must not be empty");
  if (suite.model.trim().length === 0) throw new TypeError("model must not be empty");
  if (suite.policyFingerprint.trim().length === 0) {
    throw new TypeError("policyFingerprint must not be empty");
  }
  if (!Number.isFinite(suite.threshold) || suite.threshold < 0 || suite.threshold > 1) {
    throw new TypeError("threshold must be between zero and one");
  }
  if (
    suite.mode.kind === "sampled-online" &&
    (!Number.isFinite(suite.mode.sampleRate) || suite.mode.sampleRate < 0 || suite.mode.sampleRate > 1)
  ) {
    throw new TypeError("sampleRate must be between zero and one");
  }
  const ids = new Set<string>();
  for (const item of suite.cases) {
    if (!identifier.test(item.id)) throw new TypeError("case id is invalid");
    if (ids.has(item.id)) throw new Error("duplicate evaluation case: " + item.id);
    ids.add(item.id);
  }
}

export class EvaluationRunner {
  constructor(
    readonly options: EvaluationRunnerOptions,
    readonly registry: EvaluatorRegistry,
    readonly reportSink?: EvaluationReportSink,
    readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
      throw new TypeError("maxConcurrency must be a positive safe integer");
    }
  }

  async run<I, O, E>(
    suite: EvaluationSuite<I, E>,
    subject: EvaluationSubject<I, O>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<EvaluationReport> {
    validateSuite(suite);
    const evaluator = this.registry.get(suite.evaluator);
    if (evaluator === undefined) throw new Error("evaluator is not registered: " + suite.evaluator);
    const results: EvaluationCaseResult[] = suite.cases.map((item) => ({
      ...this.#metadata(suite, item, 0),
      status: "skipped",
      reason: "not-sampled"
    }));
    const selected = suite.cases
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => sampled(item.id, suite.mode));
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length && !signal.aborted) {
        const current = selected[cursor];
        cursor += 1;
        if (current === undefined) return;
        results[current.index] = await this.#runCase(suite, current.item, subject, evaluator, signal);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.maxConcurrency, selected.length) }, worker)
    );
    const executedResults = results.filter((result) => result.status !== "skipped");
    const scoredResults = executedResults.filter(
      (result): result is EvaluationCaseMetadata & { status: "passed" | "failed"; score: number } =>
        result.status === "passed" || result.status === "failed"
    );
    const passed = results.filter((result) => result.status === "passed").length;
    const failed = executedResults.length - passed;
    const withoutDelivery = {
      suiteId: suite.id,
      suiteVersion: suite.version,
      evaluator: suite.evaluator,
      model: suite.model,
      policyFingerprint: suite.policyFingerprint,
      results,
      executed: executedResults.length,
      passed,
      failed,
      skipped: results.length - executedResults.length,
      passRate: executedResults.length === 0 ? 0 : passed / executedResults.length,
      meanScore:
        scoredResults.length === 0
          ? 0
          : scoredResults.reduce((sum, result) => sum + result.score, 0) / scoredResults.length
    };
    let delivery: EvaluationDelivery = { kind: "not-configured" };
    if (this.reportSink !== undefined) {
      try {
        await this.reportSink.write(withoutDelivery);
        delivery = { kind: "stored" };
      } catch {
        delivery = { kind: "failed", code: "report_sink_error" };
      }
    }
    return { ...withoutDelivery, delivery };
  }

  #metadata<I, E>(
    suite: EvaluationSuite<I, E>,
    item: EvaluationCase<I, E>,
    durationMs: number
  ): EvaluationCaseMetadata {
    return {
      caseId: item.id,
      route: item.route,
      promptVersion: item.promptVersion,
      model: suite.model,
      policyFingerprint: suite.policyFingerprint,
      metadataKeys: Object.keys(item.metadata).sort(),
      durationMs
    };
  }

  async #runCase<I, O, E>(
    suite: EvaluationSuite<I, E>,
    item: EvaluationCase<I, E>,
    subject: EvaluationSubject<I, O>,
    evaluator: RegisteredEvaluator,
    signal: AbortSignal
  ): Promise<EvaluationCaseResult> {
    const started = this.now();
    const context = {
      caseId: item.id,
      route: item.route,
      promptVersion: item.promptVersion,
      model: suite.model,
      policyFingerprint: suite.policyFingerprint
    };
    let result: ModelResult<O>;
    try {
      result = await subject.invoke(item.input, context, signal);
    } catch {
      return {
        ...this.#metadata(suite, item, this.now() - started),
        status: "provider-failure",
        failureKind: "subject_error"
      };
    }
    if (result.kind === "failure") {
      return {
        ...this.#metadata(suite, item, this.now() - started),
        status: "provider-failure",
        failureKind: result.failure.kind
      };
    }
    let score: number;
    try {
      score = await evaluator.score(result.value, item.expected);
    } catch {
      return {
        ...this.#metadata(suite, item, this.now() - started),
        status: "scorer-error",
        code: "scorer_error"
      };
    }
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      return {
        ...this.#metadata(suite, item, this.now() - started),
        status: "scorer-error",
        code: "scorer_error"
      };
    }
    return {
      ...this.#metadata(suite, item, this.now() - started),
      status: score >= suite.threshold ? "passed" : "failed",
      score
    };
  }
}

export interface EvaluationBaseline {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly passRate: number;
  readonly meanScore: number;
}

export type RegressionDecision =
  | { readonly kind: "accepted"; readonly passRateDrop: number; readonly meanScoreDrop: number }
  | {
      readonly kind: "regressed";
      readonly passRateDrop: number;
      readonly meanScoreDrop: number;
      readonly reasons: readonly ("pass-rate" | "mean-score")[];
    };

export function compareBaseline(
  report: EvaluationReport,
  baseline: EvaluationBaseline,
  limits: { readonly maxPassRateDrop: number; readonly maxMeanScoreDrop: number }
): RegressionDecision {
  if (report.suiteId !== baseline.suiteId) throw new Error("baseline suite id does not match");
  const passRateDrop = Math.max(0, baseline.passRate - report.passRate);
  const meanScoreDrop = Math.max(0, baseline.meanScore - report.meanScore);
  const reasons: ("pass-rate" | "mean-score")[] = [];
  if (passRateDrop > limits.maxPassRateDrop) reasons.push("pass-rate");
  if (meanScoreDrop > limits.maxMeanScoreDrop) reasons.push("mean-score");
  return reasons.length === 0
    ? { kind: "accepted", passRateDrop, meanScoreDrop }
    : { kind: "regressed", passRateDrop, meanScoreDrop, reasons };
}

export async function recordHumanFeedback(
  port: HumanFeedbackPort,
  requestId: string,
  score: number,
  note?: string
): Promise<void> {
  if (!Number.isFinite(score) || score < -1 || score > 1) {
    throw new TypeError("feedback score must be between minus one and one");
  }
  await port.record(requestId, score, note);
}
`;

const evaluationTests = `import assert from "node:assert/strict";
import test from "node:test";
import {
  EvaluationRunner,
  EvaluatorRegistry,
  compareBaseline,
  recordHumanFeedback
} from "./evaluation.js";
import type { EvaluationReport, EvaluationSuite } from "./evaluation.js";

const registry = () =>
  new EvaluatorRegistry().register<string, string>({
    id: "exact",
    score: (actual, expected) => (actual === expected ? 1 : 0)
  });

const suite: EvaluationSuite<string, string> = {
  id: "answers",
  version: "v1",
  evaluator: "exact",
  threshold: 1,
  mode: { kind: "offline" },
  model: "test/model",
  policyFingerprint: "sha256:test",
  cases: [
    { id: "one", input: "one", expected: "ONE", route: "primary", promptVersion: "p1", metadata: {} },
    { id: "two", input: "two", expected: "TWO", route: "primary", promptVersion: "p1", metadata: {} },
    { id: "three", input: "three", expected: "THREE", route: "fallback", promptVersion: "p1", metadata: {} }
  ]
};

test("runs an offline suite with reproducible metadata and bounded concurrency", async () => {
  let active = 0;
  let maximum = 0;
  let stored: Omit<EvaluationReport, "delivery"> | undefined;
  const runner = new EvaluationRunner(
    { maxConcurrency: 2 },
    registry(),
    { write: async (report) => { stored = report; } },
    () => 10
  );
  const report = await runner.run(suite, {
    invoke: async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      if (input === "three") {
        return { kind: "failure", failure: { kind: "provider", message: "bad", retryable: false } };
      }
      return {
        kind: "success",
        value: input === "one" ? "ONE" : "wrong",
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }
      };
    }
  });
  assert.equal(maximum, 2);
  assert.equal(report.executed, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.delivery.kind, "stored");
  assert.ok(stored !== undefined);
  assert.equal(stored.policyFingerprint, "sha256:test");
  assert.deepEqual(report.results.map((result) => result.status), [
    "passed",
    "failed",
    "provider-failure"
  ]);
});

test("samples online cases deterministically without invoking skipped cases", async () => {
  let calls = 0;
  const report = await new EvaluationRunner({ maxConcurrency: 1 }, registry()).run(
    { ...suite, mode: { kind: "sampled-online", sampleRate: 0, seed: "fixed" } },
    { invoke: async () => { calls += 1; throw new Error("must not run"); } }
  );
  assert.equal(calls, 0);
  assert.equal(report.executed, 0);
  assert.equal(report.skipped, 3);
});

test("detects baseline regression and validates feedback scores", async () => {
  const decision = compareBaseline(
    { suiteId: "answers", suiteVersion: "v2", evaluator: "exact", model: "test/model",
      policyFingerprint: "sha256:test", results: [], executed: 1, passed: 0, failed: 1,
      skipped: 0, passRate: 0.5, meanScore: 0.4, delivery: { kind: "not-configured" } },
    { suiteId: "answers", suiteVersion: "v1", passRate: 0.9, meanScore: 0.8 },
    { maxPassRateDrop: 0.1, maxMeanScoreDrop: 0.1 }
  );
  assert.deepEqual(decision.kind === "regressed" ? decision.reasons : [], ["pass-rate", "mean-score"]);
  const feedback: unknown[][] = [];
  await recordHumanFeedback({ record: async (...values) => void feedback.push(values) }, "request-1", 1, "good");
  assert.deepEqual(feedback, [["request-1", 1, "good"]]);
  await assert.rejects(() => recordHumanFeedback({ record: async () => undefined }, "request-1", 2));
});

test("rejects duplicate evaluator and case identifiers", async () => {
  const evaluators = registry();
  assert.throws(() => evaluators.register({ id: "exact", score: () => 1 }), /already registered/);
  await assert.rejects(
    () => new EvaluationRunner({ maxConcurrency: 1 }, evaluators).run(
      { ...suite, cases: [suite.cases[0], suite.cases[0]] },
      { invoke: async () => ({ kind: "success", value: "ONE", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }) }
    ),
    /duplicate evaluation case/
  );
});
`;

export const typeScriptRuntimeModules: readonly RuntimeModuleDefinition[] = [
  {
    id: "tooling",
    description: "Registered, guarded, approval-aware tool execution.",
    artifacts: [
      { path: "modules/tooling.ts", source: tooling },
      { path: "modules/tooling.test.ts", source: toolingTests }
    ]
  },
  {
    id: "evaluation",
    description: "Versioned offline and sampled-online evaluation runner.",
    artifacts: [
      { path: "modules/evaluation.ts", source: evaluation },
      { path: "modules/evaluation.test.ts", source: evaluationTests }
    ]
  }
];
