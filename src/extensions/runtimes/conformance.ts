export const RUNTIME_CONFORMANCE = {
  schemaVersion: 1,
  wire: {
    success: {
      keys: ["data", "usage"],
      usageKeys: ["estimatedCostUsd", "inputTokens", "outputTokens"]
    },
    failure: {
      keys: ["error"],
      errorKeys: ["kind", "message"]
    }
  },
  providerCases: [
    {
      id: "http-200-failed-response",
      statusCode: 200,
      body: {
        status: "failed",
        error: { code: "response_failed", message: "provider rejected response" }
      },
      expected: {
        kind: "failure",
        failureKind: "provider",
        providerCode: "response_failed",
        retryable: false
      }
    }
  ],
  optionCases: [
    {
      id: "invalid-circuit-failure-threshold",
      field: "circuitFailureThreshold",
      value: 0,
      expected: "construction-error"
    },
    {
      id: "invalid-circuit-reset-duration",
      field: "circuitResetAfterMs",
      value: 0,
      expected: "construction-error"
    },
    {
      id: "invalid-half-open-attempt-limit",
      field: "circuitHalfOpenMaxAttempts",
      value: 0,
      expected: "construction-error"
    }
  ],
  runtime: {
    synchronousAdapterThrow: "provider-failure",
    defaultJitter: "runtime-random",
    guardStages: ["input", "output"],
    toolControl: "validated-tool-module"
  }
} as const;

export function runtimeConformanceJson(): string {
  return `${JSON.stringify(RUNTIME_CONFORMANCE, undefined, 2)}\n`;
}
