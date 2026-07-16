import { typeScriptIntegrations } from "./integrations/typescript.js";
import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `export type FailureKind =
  | "timeout"
  | "rate-limit"
  | "provider"
  | "invalid-output"
  | "guard-rejected"
  | "approval-required"
  | "budget-exhausted"
  | "circuit-open"
  | "cancelled";

export interface ModelRequest {
  readonly id: string;
  readonly route: string;
  readonly promptVersion: string;
  readonly input: unknown;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export type ModelResult<T> =
  | { readonly kind: "success"; readonly value: T; readonly usage: Usage }
  | { readonly kind: "failure"; readonly failure: ModelFailure };

export interface ModelFailure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly providerCode?: string;
}

export interface ModelAdapter {
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResult<unknown>>;
}

export type RuntimeEvent =
  | RuntimeEventBase<"request-started">
  | RuntimeEventBase<"attempt-started"> & { readonly route: string; readonly attempt: number }
  | RuntimeEventBase<"retry-scheduled"> & { readonly delayMs: number; readonly attempt: number }
  | RuntimeEventBase<"fallback-selected"> & { readonly route: string }
  | RuntimeEventBase<"cache-hit">
  | RuntimeEventBase<"request-succeeded"> & { readonly usage: Usage; readonly latencyMs: number }
  | RuntimeEventBase<"request-failed"> & { readonly failureKind: FailureKind };

interface RuntimeEventBase<T extends string> {
  readonly type: T;
  readonly requestId: string;
  readonly occurredAt: number;
  readonly promptVersion: string;
  readonly metadataKeys: readonly string[];
}

export interface EventSink {
  emit(event: RuntimeEvent): Promise<void>;
}

export type GuardStage = "input" | "output" | "tool";

export interface GuardContext {
  readonly stage: GuardStage;
  readonly request: ModelRequest;
  readonly value: unknown;
}

export interface Guard {
  check(context: GuardContext): Promise<GuardDecision>;
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface CachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface ApprovalPort {
  approve(request: ModelRequest, reason: string): Promise<boolean>;
}

export interface EvaluationPort {
  record(request: ModelRequest, result: ModelResult<unknown>): Promise<void>;
}

export interface HumanFeedbackPort {
  record(requestId: string, score: number, note?: string): Promise<void>;
}

export type ValidationResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly reason: string };

export interface OutputValidator<T> {
  validate(value: unknown): ValidationResult<T>;
}

export interface RepairPort {
  repair(
    request: ModelRequest,
    invalidValue: unknown,
    reason: string,
    signal: AbortSignal
  ): Promise<unknown>;
}

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface RuntimeOptions {
  readonly timeoutMs: number;
  readonly retry: RetryOptions;
  readonly fallbackRoutes: readonly string[];
  readonly maxRepairAttempts: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxEstimatedCostUsd?: number;
  readonly maxConcurrency: number;
  readonly maxBatchSize: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetAfterMs: number;
}

export interface ExecuteOptions<T> {
  readonly signal?: AbortSignal;
  readonly validator?: OutputValidator<T>;
  readonly cacheKey?: string;
  readonly approvalReason?: string;
}

export interface RuntimeDependencies {
  readonly adapters: AdapterRegistry;
  readonly guards?: GuardRegistry;
  readonly events?: EventSink;
  readonly cache?: CachePort;
  readonly approval?: ApprovalPort;
  readonly evaluation?: EvaluationPort;
  readonly repair?: RepairPort;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, ModelAdapter>();

  register(route: string, adapter: ModelAdapter): this {
    if (route.trim().length === 0) throw new TypeError("route must not be empty");
    if (this.#adapters.has(route)) throw new Error("adapter already registered for route " + route);
    this.#adapters.set(route, adapter);
    return this;
  }

  get(route: string): ModelAdapter | undefined {
    return this.#adapters.get(route);
  }
}

export class GuardRegistry {
  readonly #guards = new Map<GuardStage, Guard[]>();

  register(stage: GuardStage, guard: Guard): this {
    const guards = this.#guards.get(stage) ?? [];
    guards.push(guard);
    this.#guards.set(stage, guards);
    return this;
  }

  async check(context: GuardContext): Promise<GuardDecision> {
    for (const guard of this.#guards.get(context.stage) ?? []) {
      const decision = await guard.check(context);
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  }
}

export function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number = Math.random
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be positive");
  const bounded = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = bounded * jitterRatio * Math.max(0, Math.min(1, random()));
  return Math.round(bounded + jitter);
}

export function enforceBudget(
  request: ModelRequest,
  inputTokens: number,
  maxInputTokens: number,
  maxOutputTokens: number
): ModelFailure | undefined {
  if (inputTokens <= maxInputTokens && request.maxOutputTokens <= maxOutputTokens) return undefined;
  return {
    kind: "budget-exhausted",
    message: "The request exceeds its configured token budget.",
    retryable: false
  };
}

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  #state: CircuitState = "closed";
  #failures = 0;
  #openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly resetAfterMs: number
  ) {}

  state(now = Date.now()): CircuitState {
    if (this.#state === "open" && now - this.#openedAt >= this.resetAfterMs) {
      this.#state = "half-open";
    }
    return this.#state;
  }

  allow(now = Date.now()): boolean {
    return this.state(now) !== "open";
  }

  success(): void {
    this.#state = "closed";
    this.#failures = 0;
  }

  failure(now = Date.now()): void {
    this.#failures += 1;
    if (this.#state === "half-open" || this.#failures >= this.failureThreshold) {
      this.#state = "open";
      this.#openedAt = now;
    }
  }
}

function failed(kind: FailureKind, message: string, retryable = false): ModelResult<never> {
  return { kind: "failure", failure: { kind, message, retryable } };
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("cancelled"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true }
    );
  });
}

class ConcurrencyGate {
  #active = 0;
  readonly #waiting: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
  }> = [];

  constructor(private readonly maximum: number) {}

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error("cancelled"));
    if (this.#active < this.maximum) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      this.#waiting.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.#waiting.indexOf(waiter);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(new Error("cancelled"));
        },
        { once: true }
      );
    });
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#active -= 1;
      return;
    }
    if (next.signal?.aborted === true) {
      next.reject(new Error("cancelled"));
      this.release();
      return;
    }
    next.resolve();
  }
}

export class HarnessRuntime {
  readonly #gate: ConcurrencyGate;
  readonly #circuits = new Map<string, CircuitBreaker>();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    readonly options: RuntimeOptions,
    readonly dependencies: RuntimeDependencies
  ) {
    if (options.timeoutMs < 1) throw new RangeError("timeoutMs must be positive");
    if (options.retry.maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
    if (options.maxConcurrency < 1) throw new RangeError("maxConcurrency must be positive");
    if (options.maxBatchSize < 1) throw new RangeError("maxBatchSize must be positive");
    this.#gate = new ConcurrencyGate(options.maxConcurrency);
    this.#now = dependencies.now ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
    this.#sleep = dependencies.sleep ?? defaultSleep;
  }

  async execute<T>(request: ModelRequest, executeOptions: ExecuteOptions<T> = {}): Promise<ModelResult<T>> {
    try {
      await this.#gate.acquire(executeOptions.signal);
    } catch {
      return failed("cancelled", "The request was cancelled while waiting for capacity.");
    }
    const startedAt = this.#now();
    try {
      await this.#emit("request-started", request);
      const budgetFailure = enforceBudget(
        request,
        request.inputTokens,
        this.options.maxInputTokens,
        this.options.maxOutputTokens
      );
      if (budgetFailure !== undefined) return this.#finishFailure(request, budgetFailure);

      const inputDecision = await this.dependencies.guards?.check({
        stage: "input",
        request,
        value: request.input
      });
      if (inputDecision?.allowed === false) {
        return this.#finishFailure(request, {
          kind: "guard-rejected",
          message: inputDecision.reason,
          retryable: false
        });
      }

      if (executeOptions.approvalReason !== undefined) {
        const approved = await this.dependencies.approval?.approve(
          request,
          executeOptions.approvalReason
        );
        if (approved !== true) {
          return this.#finishFailure(request, {
            kind: "approval-required",
            message: "The configured human approval was not granted.",
            retryable: false
          });
        }
      }

      if (executeOptions.cacheKey !== undefined && this.dependencies.cache !== undefined) {
        const cached = await this.dependencies.cache.get<T>(executeOptions.cacheKey);
        if (cached !== undefined) {
          await this.#emit("cache-hit", request);
          const result: ModelResult<T> = {
            kind: "success",
            value: cached,
            usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
          };
          await this.#record(request, result);
          return result;
        }
      }

      const routes = [request.route, ...this.options.fallbackRoutes].filter(
        (route, index, all) => all.indexOf(route) === index
      );
      let finalFailure: ModelFailure = {
        kind: "provider",
        message: "No registered route could complete the request.",
        retryable: false
      };

      for (const [routeIndex, route] of routes.entries()) {
        if (routeIndex > 0) await this.#emit("fallback-selected", request, { route });
        const adapter = this.dependencies.adapters.get(route);
        if (adapter === undefined) {
          finalFailure = {
            kind: "provider",
            message: "No adapter is registered for route " + route + ".",
            retryable: false
          };
          continue;
        }
        const circuit = this.#circuit(route);
        if (!circuit.allow(this.#now())) {
          finalFailure = {
            kind: "circuit-open",
            message: "The circuit is open for route " + route + ".",
            retryable: true
          };
          continue;
        }

        for (let attempt = 1; attempt <= this.options.retry.maxAttempts; attempt += 1) {
          if (executeOptions.signal?.aborted === true) {
            return this.#finishFailure(request, {
              kind: "cancelled",
              message: "The request was cancelled.",
              retryable: false
            });
          }
          await this.#emit("attempt-started", request, { route, attempt });
          const result = await this.#invoke(adapter, request, executeOptions.signal);
          if (result.kind === "success") {
            const resolved = await this.#validateAndRepair(
              request,
              result.value,
              executeOptions.validator,
              executeOptions.signal
            );
            if (resolved.kind === "failure") {
              finalFailure = resolved.failure;
              break;
            }
            const outputDecision = await this.dependencies.guards?.check({
              stage: "output",
              request,
              value: resolved.value
            });
            if (outputDecision?.allowed === false) {
              return this.#finishFailure(request, {
                kind: "guard-rejected",
                message: outputDecision.reason,
                retryable: false
              });
            }
            if (
              this.options.maxEstimatedCostUsd !== undefined &&
              result.usage.estimatedCostUsd > this.options.maxEstimatedCostUsd
            ) {
              return this.#finishFailure(request, {
                kind: "budget-exhausted",
                message: "The result exceeds its configured cost budget.",
                retryable: false
              });
            }
            circuit.success();
            const success: ModelResult<T> = {
              kind: "success",
              value: resolved.value,
              usage: result.usage
            };
            if (executeOptions.cacheKey !== undefined) {
              await this.dependencies.cache?.set(executeOptions.cacheKey, resolved.value);
            }
            await this.#emit("request-succeeded", request, {
              usage: result.usage,
              latencyMs: Math.max(0, this.#now() - startedAt)
            });
            await this.#record(request, success);
            return success;
          }

          finalFailure = result.failure;
          if (result.failure.retryable) circuit.failure(this.#now());
          if (!result.failure.retryable || attempt >= this.options.retry.maxAttempts) break;
          const delayMs = retryDelayMs(
            attempt,
            this.options.retry.baseDelayMs,
            this.options.retry.maxDelayMs,
            this.options.retry.jitterRatio,
            this.#random
          );
          await this.#emit("retry-scheduled", request, { delayMs, attempt });
          try {
            await this.#sleep(delayMs, executeOptions.signal);
          } catch {
            return this.#finishFailure(request, {
              kind: "cancelled",
              message: "The request was cancelled during retry backoff.",
              retryable: false
            });
          }
        }
      }
      return this.#finishFailure(request, finalFailure);
    } finally {
      this.#gate.release();
    }
  }

  async executeBatch<T>(
    requests: readonly ModelRequest[],
    executeOptions: ExecuteOptions<T> = {}
  ): Promise<readonly ModelResult<T>[]> {
    if (requests.length > this.options.maxBatchSize) {
      throw new RangeError("batch exceeds maxBatchSize");
    }
    return Promise.all(requests.map(async (request) => this.execute(request, executeOptions)));
  }

  #circuit(route: string): CircuitBreaker {
    const existing = this.#circuits.get(route);
    if (existing !== undefined) return existing;
    const circuit = new CircuitBreaker(
      this.options.circuitFailureThreshold,
      this.options.circuitResetAfterMs
    );
    this.#circuits.set(route, circuit);
    return circuit;
  }

  async #invoke(
    adapter: ModelAdapter,
    request: ModelRequest,
    externalSignal?: AbortSignal
  ): Promise<ModelResult<unknown>> {
    if (externalSignal?.aborted === true) {
      return failed("cancelled", "The request was cancelled.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    externalSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const aborted = new Promise<ModelResult<never>>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          resolve(
            failed(
              timedOut ? "timeout" : "cancelled",
              timedOut ? "The model deadline expired." : "The request was cancelled.",
              timedOut
            )
          );
        },
        { once: true }
      );
    });
    try {
      const invocation = Promise.resolve(adapter.invoke(request, controller.signal)).catch(
        (error: unknown) =>
          failed(
            "provider",
            error instanceof Error ? error.message : "The provider adapter failed.",
            true
          )
      );
      return await Promise.race([invocation, aborted]);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }

  async #validateAndRepair<T>(
    request: ModelRequest,
    initialValue: unknown,
    validator: OutputValidator<T> | undefined,
    signal: AbortSignal | undefined
  ): Promise<ModelResult<T>> {
    if (validator === undefined) {
      return {
        kind: "success",
        value: initialValue as T,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      };
    }
    let candidate = initialValue;
    for (let repairAttempt = 0; repairAttempt <= this.options.maxRepairAttempts; repairAttempt += 1) {
      const validation = validator.validate(candidate);
      if (validation.valid) {
        return {
          kind: "success",
          value: validation.value,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
        };
      }
      if (repairAttempt >= this.options.maxRepairAttempts || this.dependencies.repair === undefined) {
        return failed("invalid-output", validation.reason);
      }
      try {
        candidate = await this.dependencies.repair.repair(
          request,
          candidate,
          validation.reason,
          signal ?? new AbortController().signal
        );
      } catch (error) {
        return failed(
          "invalid-output",
          error instanceof Error ? error.message : "Structured output repair failed."
        );
      }
    }
    return failed("invalid-output", "Structured output could not be validated.");
  }

  async #finishFailure<T>(request: ModelRequest, failure: ModelFailure): Promise<ModelResult<T>> {
    const result: ModelResult<T> = { kind: "failure", failure };
    await this.#emit("request-failed", request, { failureKind: failure.kind });
    await this.#record(request, result);
    return result;
  }

  async #record(request: ModelRequest, result: ModelResult<unknown>): Promise<void> {
    try {
      await this.dependencies.evaluation?.record(request, result);
    } catch {
      // Evaluation storage is an integration boundary and must not corrupt inference.
    }
  }

  async #emit(
    type: RuntimeEvent["type"],
    request: ModelRequest,
    details: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    if (this.dependencies.events === undefined) return;
    const event = {
      type,
      requestId: request.id,
      occurredAt: this.#now(),
      promptVersion: request.promptVersion,
      metadataKeys: Object.keys(request.metadata).sort(),
      ...details
    } as RuntimeEvent;
    try {
      await this.dependencies.events.emit(event);
    } catch {
      // Telemetry failures do not alter the model result.
    }
  }
}
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterRegistry,
  CircuitBreaker,
  GuardRegistry,
  HarnessRuntime,
  enforceBudget,
  retryDelayMs,
  type ModelAdapter,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeOptions
} from "./runtime.js";

const request: ModelRequest = {
  id: "request-1",
  route: "primary",
  promptVersion: "v1",
  input: {},
  inputTokens: 10,
  maxOutputTokens: 100,
  metadata: { tenant: "secret-value" }
};

const options: RuntimeOptions = {
  timeoutMs: 1_000,
  retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
  fallbackRoutes: ["fallback"],
  maxRepairAttempts: 1,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  maxConcurrency: 2,
  maxBatchSize: 4,
  circuitFailureThreshold: 3,
  circuitResetAfterMs: 1_000
};

test("bounded retry delay is deterministic with injected randomness", () => {
  assert.equal(retryDelayMs(2, 100, 1_000, 0.5, () => 0), 200);
  assert.throws(() => retryDelayMs(0, 100, 1_000, 0, () => 0));
});

test("token budgets fail closed", () => {
  assert.equal(enforceBudget(request, 10, 10, 100), undefined);
  assert.equal(enforceBudget(request, 11, 10, 100)?.kind, "budget-exhausted");
});

test("circuit breaker opens, half-opens, and resets", () => {
  const breaker = new CircuitBreaker(2, 100);
  breaker.failure(0);
  assert.equal(breaker.allow(1), true);
  breaker.failure(2);
  assert.equal(breaker.allow(50), false);
  assert.equal(breaker.allow(102), true);
  breaker.success();
  assert.equal(breaker.allow(103), true);
});

test("runtime retries, falls back, repairs output, and emits redacted events", async () => {
  let primaryCalls = 0;
  const primary: ModelAdapter = {
    async invoke() {
      primaryCalls += 1;
      return {
        kind: "failure",
        failure: { kind: "rate-limit", message: "busy", retryable: true }
      };
    }
  };
  const fallback: ModelAdapter = {
    async invoke() {
      return {
        kind: "success",
        value: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.01 }
      };
    }
  };
  const events: RuntimeEvent[] = [];
  const delays: number[] = [];
  const runtime = new HarnessRuntime(options, {
    adapters: new AdapterRegistry().register("primary", primary).register("fallback", fallback),
    events: { emit: async (event) => void events.push(event) },
    repair: {
      repair: async (_request, value) => ({ answer: String((value as { answer: number }).answer) })
    },
    sleep: async (delay) => void delays.push(delay),
    random: () => 0,
    now: () => 100
  });
  const result = await runtime.execute(request, {
    validator: {
      validate(value) {
        const answer = (value as { answer?: unknown }).answer;
        return typeof answer === "string"
          ? { valid: true, value: { answer } }
          : { valid: false, reason: "answer must be a string" };
      }
    }
  });
  assert.deepEqual(result, {
    kind: "success",
    value: { answer: "42" },
    usage: { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.01 }
  });
  assert.equal(primaryCalls, 2);
  assert.deepEqual(delays, [10]);
  assert.ok(events.some((event) => event.type === "fallback-selected"));
  assert.deepEqual(events[0]?.metadataKeys, ["tenant"]);
  assert.equal("input" in (events[0] ?? {}), false);
});

test("runtime fails closed on guards and human approval", async () => {
  let calls = 0;
  const adapters = new AdapterRegistry().register("primary", {
    async invoke() {
      calls += 1;
      return {
        kind: "success",
        value: "unsafe",
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }
      };
    }
  });
  const guards = new GuardRegistry().register("input", {
    check: async () => ({ allowed: false, reason: "blocked by policy" })
  });
  const guarded = await new HarnessRuntime(options, { adapters, guards }).execute(request);
  assert.equal(guarded.kind, "failure");
  if (guarded.kind === "failure") assert.equal(guarded.failure.kind, "guard-rejected");
  const approval = await new HarnessRuntime(options, { adapters }).execute(request, {
    approvalReason: "external side effect"
  });
  assert.equal(approval.kind, "failure");
  if (approval.kind === "failure") assert.equal(approval.failure.kind, "approval-required");
  assert.equal(calls, 0);
});

test("runtime cache and batch concurrency are bounded", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const values = new Map<string, unknown>();
  const runtime = new HarnessRuntime({ ...options, maxConcurrency: 1 }, {
    adapters: new AdapterRegistry().register("primary", {
      async invoke() {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          kind: "success",
          value: "fresh",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }
        };
      }
    }),
    cache: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async <T>(key: string, value: T) => void values.set(key, value)
    }
  });
  await runtime.execute(request, { cacheKey: "one" });
  const cached = await runtime.execute(request, { cacheKey: "one" });
  assert.equal(cached.kind === "success" ? cached.value : undefined, "fresh");
  await runtime.executeBatch([request, { ...request, id: "request-2" }]);
  assert.equal(calls, 3);
  assert.equal(maximumActive, 1);
});
`;

export const typescriptRuntime = createRuntimeTemplate({
  id: "typescript-runtime",
  language: "typescript",
  displayName: "TypeScript",
  fileName: "runtime.ts",
  source: SOURCE,
  testFileName: "runtime.test.ts",
  testSource: TEST_SOURCE,
  integrations: typeScriptIntegrations
});

export function createTypeScriptRuntimeLoader() {
  return runtimeLoader(typescriptRuntime);
}

export const typescriptRuntimeLoader = createTypeScriptRuntimeLoader();
