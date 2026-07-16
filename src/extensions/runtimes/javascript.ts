import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `/** @typedef {"closed" | "open" | "half-open"} CircuitState */

export function retryDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio, random = Math.random) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be positive");
  const bounded = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = bounded * jitterRatio * Math.max(0, Math.min(1, random()));
  return Math.round(bounded + jitter);
}

export function enforceBudget(request, inputTokens, maxInputTokens, maxOutputTokens) {
  if (inputTokens <= maxInputTokens && request.maxOutputTokens <= maxOutputTokens) return undefined;
  return {
    kind: "budget-exhausted",
    message: "The request exceeds its configured token budget.",
    retryable: false
  };
}

export class CircuitBreaker {
  #state = "closed";
  #failures = 0;
  #openedAt = 0;

  constructor(failureThreshold, resetAfterMs) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError("failureThreshold must be positive");
    }
    this.failureThreshold = failureThreshold;
    this.resetAfterMs = resetAfterMs;
  }

  state(now = Date.now()) {
    if (this.#state === "open" && now - this.#openedAt >= this.resetAfterMs) {
      this.#state = "half-open";
    }
    return this.#state;
  }

  allow(now = Date.now()) {
    return this.state(now) !== "open";
  }

  success() {
    this.#state = "closed";
    this.#failures = 0;
  }

  failure(now = Date.now()) {
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
import { CircuitBreaker, enforceBudget, retryDelayMs } from "./runtime.js";

const request = { maxOutputTokens: 100 };

test("bounded retry delay is deterministic with injected randomness", () => {
  assert.equal(retryDelayMs(2, 100, 1_000, 0.5, () => 0), 200);
  assert.throws(() => retryDelayMs(0, 100, 1_000, 0, () => 0));
});

test("token budgets fail closed", () => {
  assert.equal(enforceBudget(request, 10, 10, 100), undefined);
  assert.equal(enforceBudget(request, 11, 10, 100).kind, "budget-exhausted");
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

export const javascriptRuntime = createRuntimeTemplate({
  id: "javascript-runtime",
  language: "javascript",
  displayName: "JavaScript",
  fileName: "runtime.js",
  source: SOURCE,
  testFileName: "runtime.test.js",
  testSource: TEST_SOURCE
});

export function createJavaScriptRuntimeLoader() {
  return runtimeLoader(javascriptRuntime);
}

export const javascriptRuntimeLoader = createJavaScriptRuntimeLoader();
