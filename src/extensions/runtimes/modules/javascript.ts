import type { RuntimeModuleDefinition } from "../shared.js";

const tooling = `const toolName = /^[a-z][a-z0-9._-]{0,63}$/;
const safeCode = /^[a-z][a-z0-9._-]{0,63}$/;
export class ToolRegistry {
    #tools = new Map();
    register(definition) {
        if (!toolName.test(definition.name))
            throw new TypeError("tool name is invalid");
        if (definition.description.trim().length === 0) {
            throw new TypeError("tool description must not be empty");
        }
        if (this.#tools.has(definition.name)) {
            throw new Error("tool already registered: " + definition.name);
        }
        if (definition.approval.kind === "required" && definition.approval.reason.trim().length === 0) {
            throw new TypeError("approval reason must not be empty");
        }
        const validateOutput = definition.output.kind === "validate" ? definition.output.validate : undefined;
        this.#tools.set(definition.name, {
            name: definition.name,
            description: definition.description,
            approval: definition.approval,
            validateInput: (value) => definition.validateInput(value),
            invoke: (input, context) => definition.invoke(input, context),
            ...(validateOutput === undefined
                ? {}
                : { validateOutput: (value) => validateOutput(value) })
        });
        return this;
    }
    get(name) {
        return this.#tools.get(name);
    }
    names() {
        return [...this.#tools.keys()].sort();
    }
}
function failure(kind, phase, message, code) {
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
    options;
    dependencies;
    #now;
    constructor(options, dependencies) {
        this.options = options;
        this.dependencies = dependencies;
        if (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0) {
            throw new TypeError("defaultTimeoutMs must be a positive safe integer");
        }
        if (!Number.isSafeInteger(options.maxTimeoutMs) ||
            options.maxTimeoutMs < options.defaultTimeoutMs) {
            throw new TypeError("maxTimeoutMs must be a safe integer at least defaultTimeoutMs");
        }
        this.#now = dependencies.now ?? Date.now;
    }
    async #emit(request, type) {
        try {
            await this.dependencies.events?.emit({
                type,
                requestId: request.requestId,
                tool: request.tool,
                occurredAt: this.#now(),
                metadataKeys: Object.keys(request.metadata).sort(),
                ...(request.correlation === undefined ? {} : { correlationId: request.correlation.id })
            });
        }
        catch {
            // Telemetry is an integration boundary and must not change tool semantics.
        }
    }
    async #failed(request, result) {
        await this.#emit(request, "tool-failed");
        return result;
    }
    async execute(request, parentSignal) {
        const startedAt = this.#now();
        await this.#emit(request, "tool-started");
        const tool = this.dependencies.registry.get(request.tool);
        if (tool === undefined) {
            return this.#failed(request, failure("not-found", "lookup", "The tool is not registered."));
        }
        let input;
        try {
            input = tool.validateInput(request.input);
        }
        catch {
            return this.#failed(request, failure("invalid-input", "input", "Tool input validation failed.", "validator_error"));
        }
        if (input.kind === "invalid") {
            return this.#failed(request, failure("invalid-input", "input", "Tool input validation failed.", input.code));
        }
        if (tool.approval.kind === "required") {
            await this.#emit(request, "approval-requested");
            if (this.dependencies.approval === undefined) {
                return this.#failed(request, failure("approval-required", "approval", "A tool approval port is required."));
            }
            let approved;
            try {
                const { input: _input, ...redactedRequest } = request;
                approved = await this.dependencies.approval.approve(redactedRequest, tool.approval.reason);
            }
            catch {
                return this.#failed(request, failure("approval-failed", "approval", "The approval decision could not be obtained."));
            }
            if (!approved) {
                return this.#failed(request, failure("approval-denied", "approval", "The tool execution was not approved."));
            }
        }
        const requestedTimeout = request.timeoutMs ?? this.options.defaultTimeoutMs;
        const timeoutMs = Math.min(Math.max(1, requestedTimeout), this.options.maxTimeoutMs);
        const controller = new AbortController();
        let timedOut = false;
        const abortFromParent = () => controller.abort();
        if (parentSignal?.aborted === true)
            controller.abort();
        else
            parentSignal?.addEventListener("abort", abortFromParent, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const invocation = Promise.resolve()
            .then(() => tool.invoke(input.value, {
            requestId: request.requestId,
            signal: controller.signal,
            ...(request.correlation === undefined ? {} : { correlation: request.correlation })
        }))
            .then((value) => ({ kind: "completed", value }), () => ({ kind: "handler-error" }));
        const aborted = controller.signal.aborted
            ? Promise.resolve({ kind: "aborted" })
            : new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
                once: true
            }));
        const outcome = await Promise.race([invocation, aborted]);
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
        if (outcome.kind === "aborted") {
            return this.#failed(request, timedOut
                ? failure("timeout", "execution", "The tool execution deadline expired.")
                : failure("cancelled", "execution", "The tool execution was cancelled."));
        }
        if (outcome.kind === "handler-error") {
            return this.#failed(request, failure("handler-error", "execution", "The tool handler failed."));
        }
        if (tool.validateOutput !== undefined) {
            let output;
            try {
                output = tool.validateOutput(outcome.value);
            }
            catch {
                return this.#failed(request, failure("invalid-output", "output", "Tool output validation failed.", "validator_error"));
            }
            if (output.kind === "invalid") {
                return this.#failed(request, failure("invalid-output", "output", "Tool output validation failed.", output.code));
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
const request = {
    requestId: "tool-1",
    tool: "math.double",
    input: 3,
    metadata: { tenant: "one", secret: "must-not-be-emitted" }
};
function numberTool(overrides = {}) {
    return {
        name: "math.double",
        description: "Doubles a number.",
        approval: { kind: "none" },
        output: { kind: "validate", validate: (value) => typeof value === "number" ? { kind: "valid", value } : { kind: "invalid", code: "not_number" }
        },
        validateInput: (value) => typeof value === "number" ? { kind: "valid", value } : { kind: "invalid", code: "not_number" },
        invoke: async (value) => value * 2,
        ...overrides
    };
}
test("registers and executes a validated tool without logging values", async () => {
    const events = [];
    const registry = new ToolRegistry().register(numberTool());
    const runner = new ToolRunner({ defaultTimeoutMs: 100, maxTimeoutMs: 1_000 }, { registry, events: { emit: async (event) => void events.push(event) }, now: () => 10 });
    const result = await runner.execute(request);
    assert.deepEqual(result, { kind: "success", value: 6, durationMs: 0 });
    assert.deepEqual(registry.names(), ["math.double"]);
    assert.equal(JSON.stringify(events).includes("must-not-be-emitted"), false);
    assert.deepEqual(events.map((event) => event.type), ["tool-started", "tool-succeeded"]);
    assert.throws(() => registry.register(numberTool()), /already registered/);
});
test("fails closed for invalid input and output", async () => {
    let calls = 0;
    const registry = new ToolRegistry().register(numberTool({
        output: { kind: "validate", validate: () => ({ kind: "invalid", code: "rejected" }) },
        invoke: async () => { calls += 1; return 4; }
    }));
    const runner = new ToolRunner({ defaultTimeoutMs: 100, maxTimeoutMs: 100 }, { registry });
    const invalidInput = await runner.execute({ ...request, input: "secret value" });
    assert.equal(invalidInput.kind === "failure" ? invalidInput.failure.kind : "", "invalid-input");
    assert.equal(JSON.stringify(invalidInput).includes("secret value"), false);
    assert.equal(calls, 0);
    const invalidOutput = await runner.execute(request);
    assert.equal(invalidOutput.kind === "failure" ? invalidOutput.failure.kind : "", "invalid-output");
});
test("requires explicit approval and never sends tool input to the approval port", async () => {
    let approvalRequest;
    const registry = new ToolRegistry().register(numberTool({ approval: { kind: "required", reason: "Changes external state." } }));
    const missing = await new ToolRunner({ defaultTimeoutMs: 100, maxTimeoutMs: 100 }, { registry }).execute(request);
    assert.equal(missing.kind === "failure" ? missing.failure.kind : "", "approval-required");
    const denied = await new ToolRunner({ defaultTimeoutMs: 100, maxTimeoutMs: 100 }, { registry, approval: { approve: async (value) => { approvalRequest = value; return false; } } }).execute(request);
    assert.equal(denied.kind === "failure" ? denied.failure.kind : "", "approval-denied");
    assert.ok(approvalRequest !== undefined);
    assert.equal("input" in approvalRequest, false);
});
test("returns on timeout even when a handler ignores cancellation", async () => {
    const registry = new ToolRegistry().register(numberTool({ invoke: async () => new Promise(() => undefined) }));
    const result = await new ToolRunner({ defaultTimeoutMs: 5, maxTimeoutMs: 5 }, { registry }).execute(request);
    assert.equal(result.kind === "failure" ? result.failure.kind : "", "timeout");
});
`;

const evaluation = `const identifier = /^[a-z][a-z0-9._-]{0,63}$/;
export class EvaluatorRegistry {
    #evaluators = new Map();
    register(definition) {
        if (!identifier.test(definition.id))
            throw new TypeError("evaluator id is invalid");
        if (this.#evaluators.has(definition.id)) {
            throw new Error("evaluator already registered: " + definition.id);
        }
        this.#evaluators.set(definition.id, {
            id: definition.id,
            score: async (actual, expected) => definition.score(actual, expected)
        });
        return this;
    }
    get(id) {
        return this.#evaluators.get(id);
    }
}
function hash(value) {
    let result = 2_166_136_261;
    for (const byte of new TextEncoder().encode(value)) {
        result ^= byte;
        result = Math.imul(result, 16_777_619);
    }
    return result >>> 0;
}
function sampled(caseId, mode) {
    if (mode.kind === "offline")
        return true;
    return hash(mode.seed + ":" + caseId) / 0x1_0000_0000 < mode.sampleRate;
}
function validateSuite(suite) {
    if (!identifier.test(suite.id))
        throw new TypeError("suite id is invalid");
    if (suite.version.trim().length === 0)
        throw new TypeError("suite version must not be empty");
    if (suite.model.trim().length === 0)
        throw new TypeError("model must not be empty");
    if (suite.policyFingerprint.trim().length === 0) {
        throw new TypeError("policyFingerprint must not be empty");
    }
    if (!Number.isFinite(suite.threshold) || suite.threshold < 0 || suite.threshold > 1) {
        throw new TypeError("threshold must be between zero and one");
    }
    if (suite.mode.kind === "sampled-online" &&
        (!Number.isFinite(suite.mode.sampleRate) || suite.mode.sampleRate < 0 || suite.mode.sampleRate > 1)) {
        throw new TypeError("sampleRate must be between zero and one");
    }
    const ids = new Set();
    for (const item of suite.cases) {
        if (!identifier.test(item.id))
            throw new TypeError("case id is invalid");
        if (ids.has(item.id))
            throw new Error("duplicate evaluation case: " + item.id);
        ids.add(item.id);
    }
}
export class EvaluationRunner {
    options;
    registry;
    reportSink;
    now;
    constructor(options, registry, reportSink, now = Date.now) {
        this.options = options;
        this.registry = registry;
        this.reportSink = reportSink;
        this.now = now;
        if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
            throw new TypeError("maxConcurrency must be a positive safe integer");
        }
    }
    async run(suite, subject, signal = new AbortController().signal) {
        validateSuite(suite);
        const evaluator = this.registry.get(suite.evaluator);
        if (evaluator === undefined)
            throw new Error("evaluator is not registered: " + suite.evaluator);
        const results = suite.cases.map((item) => ({
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
                if (current === undefined)
                    return;
                results[current.index] = await this.#runCase(suite, current.item, subject, evaluator, signal);
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.options.maxConcurrency, selected.length) }, worker));
        if (signal.aborted) {
            for (const { item, index } of selected) {
                if (results[index]?.status === "skipped") {
                    results[index] = {
                        ...this.#metadata(suite, item, 0),
                        status: "skipped",
                        reason: "cancelled"
                    };
                }
            }
        }
        const executedResults = results.filter((result) => result.status !== "skipped");
        const scoredResults = executedResults.filter((result) => result.status === "passed" || result.status === "failed");
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
            meanScore: scoredResults.length === 0
                ? 0
                : scoredResults.reduce((sum, result) => sum + result.score, 0) / scoredResults.length
        };
        let delivery = { kind: "not-configured" };
        if (this.reportSink !== undefined) {
            try {
                await this.reportSink.write(withoutDelivery);
                delivery = { kind: "stored" };
            }
            catch {
                delivery = { kind: "failed", code: "report_sink_error" };
            }
        }
        return { ...withoutDelivery, delivery };
    }
    #metadata(suite, item, durationMs) {
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
    async #runCase(suite, item, subject, evaluator, signal) {
        const started = this.now();
        const context = {
            caseId: item.id,
            route: item.route,
            promptVersion: item.promptVersion,
            model: suite.model,
            policyFingerprint: suite.policyFingerprint
        };
        let result;
        try {
            result = await subject.invoke(item.input, context, signal);
        }
        catch {
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
        let score;
        try {
            score = await evaluator.score(result.value, item.expected);
        }
        catch {
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
export function compareBaseline(report, baseline, limits) {
    if (report.suiteId !== baseline.suiteId)
        throw new Error("baseline suite id does not match");
    const passRateDrop = Math.max(0, baseline.passRate - report.passRate);
    const meanScoreDrop = Math.max(0, baseline.meanScore - report.meanScore);
    const reasons = [];
    if (passRateDrop > limits.maxPassRateDrop)
        reasons.push("pass-rate");
    if (meanScoreDrop > limits.maxMeanScoreDrop)
        reasons.push("mean-score");
    return reasons.length === 0
        ? { kind: "accepted", passRateDrop, meanScoreDrop }
        : { kind: "regressed", passRateDrop, meanScoreDrop, reasons };
}
export async function recordHumanFeedback(port, requestId, score, note) {
    if (!Number.isFinite(score) || score < -1 || score > 1) {
        throw new TypeError("feedback score must be between minus one and one");
    }
    await port.record(requestId, score, note);
}
`;

const evaluationTests = `import assert from "node:assert/strict";
import test from "node:test";
import { EvaluationRunner, EvaluatorRegistry, compareBaseline, recordHumanFeedback } from "./evaluation.js";
const registry = () => new EvaluatorRegistry().register({
    id: "exact",
    score: (actual, expected) => (actual === expected ? 1 : 0)
});
const suite = {
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
    let stored;
    const runner = new EvaluationRunner({ maxConcurrency: 2 }, registry(), { write: async (report) => { stored = report; } }, () => 10);
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
    const report = await new EvaluationRunner({ maxConcurrency: 1 }, registry()).run({ ...suite, mode: { kind: "sampled-online", sampleRate: 0, seed: "fixed" } }, { invoke: async () => { calls += 1; throw new Error("must not run"); } });
    assert.equal(calls, 0);
    assert.equal(report.executed, 0);
    assert.equal(report.skipped, 3);
});
test("distinguishes cancelled cases from sampling decisions", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await new EvaluationRunner({ maxConcurrency: 1 }, registry()).run(suite, { invoke: async () => { throw new Error("must not run"); } }, controller.signal);
    assert.deepEqual(report.results.map((result) => result.status === "skipped" ? result.reason : result.status), ["cancelled", "cancelled", "cancelled"]);
});
test("detects baseline regression and validates feedback scores", async () => {
    const decision = compareBaseline({ suiteId: "answers", suiteVersion: "v2", evaluator: "exact", model: "test/model",
        policyFingerprint: "sha256:test", results: [], executed: 1, passed: 0, failed: 1,
        skipped: 0, passRate: 0.5, meanScore: 0.4, delivery: { kind: "not-configured" } }, { suiteId: "answers", suiteVersion: "v1", passRate: 0.9, meanScore: 0.8 }, { maxPassRateDrop: 0.1, maxMeanScoreDrop: 0.1 });
    assert.deepEqual(decision.kind === "regressed" ? decision.reasons : [], ["pass-rate", "mean-score"]);
    const feedback = [];
    await recordHumanFeedback({ record: async (...values) => void feedback.push(values) }, "request-1", 1, "good");
    assert.deepEqual(feedback, [["request-1", 1, "good"]]);
    await assert.rejects(() => recordHumanFeedback({ record: async () => undefined }, "request-1", 2));
});
test("rejects duplicate evaluator and case identifiers", async () => {
    const evaluators = registry();
    assert.throws(() => evaluators.register({ id: "exact", score: () => 1 }), /already registered/);
    await assert.rejects(() => new EvaluationRunner({ maxConcurrency: 1 }, evaluators).run({ ...suite, cases: [suite.cases[0], suite.cases[0]] }, { invoke: async () => ({ kind: "success", value: "ONE", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }) }), /duplicate evaluation case/);
});
`;

export const javaScriptRuntimeModules: readonly RuntimeModuleDefinition[] = [
  {
    id: "tooling",
    description: "Registered, guarded, approval-aware tool execution.",
    artifacts: [
      { path: "modules/tooling.js", source: tooling },
      { path: "modules/tooling.test.js", source: toolingTests }
    ]
  },
  {
    id: "evaluation",
    description: "Versioned offline and sampled-online evaluation runner.",
    artifacts: [
      { path: "modules/evaluation.js", source: evaluation },
      { path: "modules/evaluation.test.js", source: evaluationTests }
    ]
  }
];
