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
  invoke<T>(request: ModelRequest, signal: AbortSignal): Promise<ModelResult<T>>;
}

export interface EventSink {
  emit(event: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface Guard {
  check(
    request: ModelRequest
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
}

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
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, enforceBudget, retryDelayMs, type ModelRequest } from "./runtime.js";

const request: ModelRequest = {
  id: "request-1",
  route: "primary",
  promptVersion: "v1",
  input: {},
  maxOutputTokens: 100,
  metadata: {}
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
`;

export const typescriptRuntime = createRuntimeTemplate({
  id: "typescript-runtime",
  language: "typescript",
  displayName: "TypeScript",
  fileName: "runtime.ts",
  source: SOURCE,
  testFileName: "runtime.test.ts",
  testSource: TEST_SOURCE
});

export function createTypeScriptRuntimeLoader() {
  return runtimeLoader(typescriptRuntime);
}

export const typescriptRuntimeLoader = createTypeScriptRuntimeLoader();
