import type { RuntimePolicy } from "../../core/index.js";
import type { IntegrationArtifactDefinition } from "./shared.js";

interface RuntimeOptionValues {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly fallbackRoutes: readonly string[];
  readonly maxRepairAttempts: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxEstimatedCostUsd?: number;
  readonly maxConcurrency: number;
  readonly maxBatchSize: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetAfterMs?: number;
  readonly circuitHalfOpenMaxAttempts: number;
}

function runtimeOptionValues(policy: RuntimePolicy): RuntimeOptionValues {
  const retry =
    policy.reliability.retry.kind === "bounded"
      ? policy.reliability.retry
      : { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  const circuit = policy.reliability.circuitBreaker;
  const circuitFailureThreshold =
    circuit.kind === "failure-threshold" ? circuit.failureThreshold : undefined;
  const circuitResetAfterMs =
    circuit.kind === "failure-threshold" ? circuit.resetAfterMs : undefined;
  const circuitHalfOpenMaxAttempts =
    circuit.kind === "failure-threshold" ? circuit.halfOpenMaxAttempts : 1;
  const tokens = policy.performance.tokenBudget;
  const maxInputTokens = tokens.kind === "limited" ? tokens.maxInputTokens : undefined;
  const maxOutputTokens = tokens.kind === "limited" ? tokens.maxOutputTokens : undefined;
  const cost =
    policy.performance.costBudget.kind === "limited"
      ? policy.performance.costBudget.maxEstimatedCostUsd
      : undefined;
  return {
    timeoutMs: policy.reliability.timeoutMs,
    maxAttempts: retry.maxAttempts,
    baseDelayMs: retry.baseDelayMs,
    maxDelayMs: retry.maxDelayMs,
    jitterRatio: retry.jitterRatio,
    fallbackRoutes:
      policy.reliability.fallback.kind === "ordered" ? policy.reliability.fallback.routes : [],
    maxRepairAttempts: policy.reliability.maxRepairAttempts,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(cost === undefined ? {} : { maxEstimatedCostUsd: cost }),
    maxConcurrency: policy.performance.maxConcurrency,
    maxBatchSize: policy.performance.maxBatchSize,
    ...(circuitFailureThreshold === undefined ? {} : { circuitFailureThreshold }),
    ...(circuitResetAfterMs === undefined ? {} : { circuitResetAfterMs }),
    circuitHalfOpenMaxAttempts
  };
}

function arrayLiteral(values: readonly string[]): string {
  return JSON.stringify(values);
}

function optionalNumber(value: number | undefined, fallback: string): string {
  return value === undefined ? fallback : String(value);
}

function costTypeScript(value: number | undefined): string {
  return value === undefined ? "" : `\n  maxEstimatedCostUsd: ${value},`;
}

function goDurationMilliseconds(value: number | undefined): string {
  return value === undefined ? "time.Duration(1<<63 - 1)" : `${value} * time.Millisecond`;
}

export function typescriptPolicyArtifact(policy: RuntimePolicy): IntegrationArtifactDefinition {
  const value = runtimeOptionValues(policy);
  return {
    path: "policy.ts",
    source: `import type { RuntimeOptions } from "./runtime.js";

/** Runtime-native options compiled from the adjacent policy.json audit record. */
export const runtimeOptions: RuntimeOptions = Object.freeze({
  timeoutMs: ${value.timeoutMs},
  retry: {
    maxAttempts: ${value.maxAttempts},
    baseDelayMs: ${value.baseDelayMs},
    maxDelayMs: ${value.maxDelayMs},
    jitterRatio: ${value.jitterRatio}
  },
  fallbackRoutes: ${arrayLiteral(value.fallbackRoutes)},
  maxRepairAttempts: ${value.maxRepairAttempts},
  maxInputTokens: ${optionalNumber(value.maxInputTokens, "Number.MAX_SAFE_INTEGER")},
  maxOutputTokens: ${optionalNumber(value.maxOutputTokens, "Number.MAX_SAFE_INTEGER")},${costTypeScript(value.maxEstimatedCostUsd)}
  maxConcurrency: ${value.maxConcurrency},
  maxBatchSize: ${value.maxBatchSize},
  circuitFailureThreshold: ${optionalNumber(value.circuitFailureThreshold, "Number.MAX_SAFE_INTEGER")},
  circuitResetAfterMs: ${optionalNumber(value.circuitResetAfterMs, "Number.MAX_SAFE_INTEGER")},
  circuitHalfOpenMaxAttempts: ${value.circuitHalfOpenMaxAttempts}
});
`
  };
}

export function javascriptPolicyArtifact(policy: RuntimePolicy): IntegrationArtifactDefinition {
  const typescript = typescriptPolicyArtifact(policy).source;
  return {
    path: "policy.js",
    source: typescript
      .replace('import type { RuntimeOptions } from "./runtime.js";\n\n', "")
      .replace(": RuntimeOptions", "")
  };
}

export function pythonPolicyArtifact(policy: RuntimePolicy): IntegrationArtifactDefinition {
  const value = runtimeOptionValues(policy);
  const routes = `(${value.fallbackRoutes.map((route) => JSON.stringify(route)).join(", ")}${value.fallbackRoutes.length === 1 ? "," : ""})`;
  return {
    path: "policy.py",
    source: `from runtime import RetryOptions, RuntimeOptions


# Runtime-native options compiled from the adjacent policy.json audit record.
RUNTIME_OPTIONS = RuntimeOptions(
    timeout_ms=${value.timeoutMs},
    retry=RetryOptions(
        max_attempts=${value.maxAttempts},
        base_delay_ms=${value.baseDelayMs},
        max_delay_ms=${value.maxDelayMs},
        jitter_ratio=${value.jitterRatio},
    ),
    fallback_routes=${routes},
    max_repair_attempts=${value.maxRepairAttempts},
    max_input_tokens=${optionalNumber(value.maxInputTokens, "2**63 - 1")},
    max_output_tokens=${optionalNumber(value.maxOutputTokens, "2**63 - 1")},
    max_concurrency=${value.maxConcurrency},
    max_batch_size=${value.maxBatchSize},
    circuit_failure_threshold=${optionalNumber(value.circuitFailureThreshold, "2**63 - 1")},
    circuit_reset_after_ms=${optionalNumber(value.circuitResetAfterMs, "2**63 - 1")},
    circuit_half_open_max_attempts=${value.circuitHalfOpenMaxAttempts},
    max_estimated_cost_usd=${value.maxEstimatedCostUsd === undefined ? "None" : value.maxEstimatedCostUsd},
)
`
  };
}

export function goPolicyArtifact(policy: RuntimePolicy): IntegrationArtifactDefinition {
  const value = runtimeOptionValues(policy);
  const routes = value.fallbackRoutes.map((route) => JSON.stringify(route)).join(", ");
  const cost =
    value.maxEstimatedCostUsd === undefined
      ? "return options"
      : `cost := ${value.maxEstimatedCostUsd}\n\toptions.MaxEstimatedCostUSD = &cost\n\treturn options`;
  return {
    path: "policy.go",
    source: `package aiyokeruntime

import "time"

// GeneratedRuntimeOptions returns options compiled from the adjacent policy.json audit record.
func GeneratedRuntimeOptions() RuntimeOptions {
\toptions := RuntimeOptions{
\t\tTimeout: ${value.timeoutMs} * time.Millisecond,
\t\tRetry: RetryOptions{
\t\t\tMaxAttempts: ${value.maxAttempts},
\t\t\tBaseDelay:   ${value.baseDelayMs} * time.Millisecond,
\t\t\tMaxDelay:    ${value.maxDelayMs} * time.Millisecond,
\t\t\tJitterRatio: ${value.jitterRatio},
\t\t},
\t\tFallbackRoutes:          []string{${routes}},
\t\tMaxRepairAttempts:       ${value.maxRepairAttempts},
\t\tMaxInputTokens:          ${optionalNumber(value.maxInputTokens, "int(^uint(0) >> 1)")},
\t\tMaxOutputTokens:         ${optionalNumber(value.maxOutputTokens, "int(^uint(0) >> 1)")},
\t\tMaxConcurrency:          ${value.maxConcurrency},
\t\tMaxBatchSize:            ${value.maxBatchSize},
\t\tCircuitFailureThreshold: ${optionalNumber(value.circuitFailureThreshold, "int(^uint(0) >> 1)")},
\t\tCircuitResetAfter:       ${goDurationMilliseconds(value.circuitResetAfterMs)},
\t\tCircuitHalfOpenAttempts: ${value.circuitHalfOpenMaxAttempts},
\t}
\t${cost}
}
`
  };
}

export function rustPolicyArtifact(policy: RuntimePolicy): IntegrationArtifactDefinition {
  const value = runtimeOptionValues(policy);
  const routes = value.fallbackRoutes
    .map((route) => `${JSON.stringify(route)}.to_owned()`)
    .join(", ");
  return {
    path: "policy.rs",
    source: `use crate::runtime::{RetryOptions, RuntimeOptions};
use std::time::Duration;

/// Returns runtime options compiled from the adjacent policy.json audit record.
pub fn generated_runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        timeout: Duration::from_millis(${value.timeoutMs}),
        retry: RetryOptions {
            max_attempts: ${value.maxAttempts},
            base_delay: Duration::from_millis(${value.baseDelayMs}),
            max_delay: Duration::from_millis(${value.maxDelayMs}),
            jitter_ratio: ${value.jitterRatio},
        },
        fallback_routes: vec![${routes}],
        max_repair_attempts: ${value.maxRepairAttempts},
        max_input_tokens: ${optionalNumber(value.maxInputTokens, "u64::MAX")},
        max_output_tokens: ${optionalNumber(value.maxOutputTokens, "u64::MAX")},
        max_estimated_cost_usd: ${value.maxEstimatedCostUsd === undefined ? "None" : `Some(${value.maxEstimatedCostUsd})`},
        max_concurrency: ${value.maxConcurrency},
        max_batch_size: ${value.maxBatchSize},
        circuit_failure_threshold: ${optionalNumber(value.circuitFailureThreshold, "u32::MAX")},
        circuit_reset_after: ${value.circuitResetAfterMs === undefined ? "Duration::MAX" : `Duration::from_millis(${value.circuitResetAfterMs})`},
        circuit_half_open_max_attempts: ${value.circuitHalfOpenMaxAttempts},
    }
}
`
  };
}
