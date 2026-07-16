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

export const javascriptRuntime = createRuntimeTemplate({
  id: "javascript-runtime",
  language: "javascript",
  displayName: "JavaScript",
  fileName: "runtime.js",
  source: SOURCE
});

export function createJavaScriptRuntimeLoader() {
  return runtimeLoader(javascriptRuntime);
}

export const javascriptRuntimeLoader = createJavaScriptRuntimeLoader();
