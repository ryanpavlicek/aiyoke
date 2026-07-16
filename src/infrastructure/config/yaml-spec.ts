import { parse, stringify } from "yaml";
import type { SchemaDocument } from "../../application/index.js";
import {
  type AgentFeature,
  AiyokeError,
  type CachePolicy,
  type CircuitBreakerPolicy,
  type CostBudgetPolicy,
  DEFAULT_RUNTIME_HARNESS,
  type EvaluationPolicy,
  extensionId,
  type FallbackPolicy,
  type HarnessSpec,
  type HarnessStack,
  type JsonObject,
  type JsonValue,
  type ObservabilityPolicy,
  type PerformancePolicy,
  type ProjectComposition,
  type ReliabilityPolicy,
  type RetryPolicy,
  type RuntimeHarnessSpec,
  type RuntimeProfile,
  type SafetyPolicy,
  safeRelativePath,
  type TargetSpec,
  type TokenBudgetPolicy
} from "../../core/index.js";

export const CURRENT_SCHEMA_VERSION = 3;

const AGENT_FEATURES = new Set<AgentFeature>([
  "instructions",
  "skills",
  "subagents",
  "hooks",
  "mcp",
  "permissions",
  "headless"
]);

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;

interface JsonValidationState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length > 0) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `${label} contains unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.sort().join(", ")}.`
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an array of strings.`);
  }
  return value;
}

function uniqueNonEmptyStringArray(value: unknown, label: string): readonly string[] {
  const items = stringArray(value, label);
  if (items.some((item) => item.trim().length === 0)) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain blank values.`);
  }
  if (new Set(items).size !== items.length) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain duplicates.`);
  }
  return items;
}

function idArray(value: unknown, label: string) {
  const ids = stringArray(value, label).map(extensionId);
  if (new Set(ids).size !== ids.length) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain duplicates.`);
  }
  return ids;
}

function isJsonValue(
  value: unknown,
  state: JsonValidationState = { ancestors: new WeakSet<object>(), nodes: 0 },
  depth = 0
): value is JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (state.ancestors.has(value)) return false;
  state.ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, state, depth + 1))
    : Object.entries(value).every(
        ([key, item]) =>
          key !== "__proto__" &&
          key !== "prototype" &&
          key !== "constructor" &&
          isJsonValue(item, state, depth + 1)
      );
  state.ancestors.delete(value);
  return valid;
}

function settings(value: unknown, label: string): JsonObject {
  const candidate = value ?? {};
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !isJsonValue(candidate)
  ) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a JSON object.`);
  }
  return candidate as JsonObject;
}

function stackSpec(value: unknown, label: string): HarnessStack {
  const stack = record(value, label);
  allowedKeys(stack, ["languages", "frameworks"], label);
  return {
    languages: idArray(stack.languages ?? [], `${label}.languages`),
    frameworks: idArray(stack.frameworks ?? [], `${label}.frameworks`)
  };
}

function compositionSpec(value: unknown): ProjectComposition {
  const composition = record(value, "composition");
  if (composition.kind === "single") {
    allowedKeys(composition, ["kind", "stack"], "composition");
    return { kind: "single", stack: stackSpec(composition.stack, "composition.stack") };
  }
  if (composition.kind === "monorepo") {
    allowedKeys(composition, ["kind", "root", "workspaces"], "composition");
    if (!Array.isArray(composition.workspaces) || composition.workspaces.length === 0) {
      throw new AiyokeError(
        "INVALID_SPEC",
        "composition.workspaces must be a non-empty array for a monorepo."
      );
    }
    const workspaces = composition.workspaces.map((value, index) => {
      const label = `composition.workspaces[${index}]`;
      const workspace = record(value, label);
      allowedKeys(workspace, ["id", "path", "stack"], label);
      return {
        id: extensionId(requiredString(workspace.id, `${label}.id`)),
        path: safeRelativePath(requiredString(workspace.path, `${label}.path`)),
        stack: stackSpec(workspace.stack, `${label}.stack`)
      };
    });
    if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) {
      throw new AiyokeError("INVALID_SPEC", "Monorepo workspace ids cannot contain duplicates.");
    }
    if (new Set(workspaces.map((workspace) => workspace.path)).size !== workspaces.length) {
      throw new AiyokeError("INVALID_SPEC", "Monorepo workspace paths cannot contain duplicates.");
    }
    return { kind: "monorepo", root: stackSpec(composition.root, "composition.root"), workspaces };
  }
  throw new AiyokeError("INVALID_SPEC", "composition.kind must be single or monorepo.");
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `${label} must be ${integer ? "an integer" : "a number"} from ${minimum} through ${maximum}.`
    );
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a boolean.`);
  }
  return value;
}

function retryPolicy(value: unknown): RetryPolicy {
  const policy = record(value, "runtime.profile.reliability.retry");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.reliability.retry");
    return { kind: "disabled" };
  }
  if (policy.kind === "bounded") {
    allowedKeys(
      policy,
      ["kind", "maxAttempts", "baseDelayMs", "maxDelayMs", "jitterRatio"],
      "runtime.profile.reliability.retry"
    );
    const baseDelayMs = boundedNumber(
      policy.baseDelayMs,
      "runtime.profile.reliability.retry.baseDelayMs",
      0,
      60_000,
      true
    );
    const maxDelayMs = boundedNumber(
      policy.maxDelayMs,
      "runtime.profile.reliability.retry.maxDelayMs",
      0,
      300_000,
      true
    );
    if (maxDelayMs < baseDelayMs) {
      throw new AiyokeError(
        "INVALID_SPEC",
        "runtime.profile.reliability.retry.maxDelayMs cannot be less than baseDelayMs."
      );
    }
    return {
      kind: "bounded",
      maxAttempts: boundedNumber(
        policy.maxAttempts,
        "runtime.profile.reliability.retry.maxAttempts",
        1,
        10,
        true
      ),
      baseDelayMs,
      maxDelayMs,
      jitterRatio: boundedNumber(
        policy.jitterRatio,
        "runtime.profile.reliability.retry.jitterRatio",
        0,
        1
      )
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.reliability.retry.kind must be disabled or bounded."
  );
}

function circuitBreakerPolicy(value: unknown): CircuitBreakerPolicy {
  const policy = record(value, "runtime.profile.reliability.circuitBreaker");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.reliability.circuitBreaker");
    return { kind: "disabled" };
  }
  if (policy.kind === "failure-threshold") {
    allowedKeys(
      policy,
      ["kind", "failureThreshold", "resetAfterMs", "halfOpenMaxAttempts"],
      "runtime.profile.reliability.circuitBreaker"
    );
    return {
      kind: "failure-threshold",
      failureThreshold: boundedNumber(
        policy.failureThreshold,
        "runtime.profile.reliability.circuitBreaker.failureThreshold",
        1,
        100,
        true
      ),
      resetAfterMs: boundedNumber(
        policy.resetAfterMs,
        "runtime.profile.reliability.circuitBreaker.resetAfterMs",
        1,
        3_600_000,
        true
      ),
      halfOpenMaxAttempts: boundedNumber(
        policy.halfOpenMaxAttempts,
        "runtime.profile.reliability.circuitBreaker.halfOpenMaxAttempts",
        1,
        10,
        true
      )
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.reliability.circuitBreaker.kind must be disabled or failure-threshold."
  );
}

function fallbackPolicy(value: unknown): FallbackPolicy {
  const policy = record(value, "runtime.profile.reliability.fallback");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.reliability.fallback");
    return { kind: "disabled" };
  }
  if (policy.kind === "ordered") {
    allowedKeys(policy, ["kind", "routes"], "runtime.profile.reliability.fallback");
    const routes = uniqueNonEmptyStringArray(
      policy.routes,
      "runtime.profile.reliability.fallback.routes"
    );
    if (routes.length === 0) {
      throw new AiyokeError(
        "INVALID_SPEC",
        "runtime.profile.reliability.fallback.routes cannot be empty."
      );
    }
    return { kind: "ordered", routes };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.reliability.fallback.kind must be disabled or ordered."
  );
}

function reliabilityPolicy(value: unknown): ReliabilityPolicy {
  const policy = record(value, "runtime.profile.reliability");
  allowedKeys(
    policy,
    ["timeoutMs", "retry", "circuitBreaker", "fallback", "maxRepairAttempts"],
    "runtime.profile.reliability"
  );
  return {
    timeoutMs: boundedNumber(
      policy.timeoutMs,
      "runtime.profile.reliability.timeoutMs",
      1,
      600_000,
      true
    ),
    retry: retryPolicy(policy.retry),
    circuitBreaker: circuitBreakerPolicy(policy.circuitBreaker),
    fallback: fallbackPolicy(policy.fallback),
    maxRepairAttempts: boundedNumber(
      policy.maxRepairAttempts,
      "runtime.profile.reliability.maxRepairAttempts",
      0,
      5,
      true
    )
  };
}

function observabilityPolicy(value: unknown): ObservabilityPolicy {
  const policy = record(value, "runtime.profile.observability");
  allowedKeys(
    policy,
    ["kind", "contentCapture", "emitTokenUsage", "emitEstimatedCost"],
    "runtime.profile.observability"
  );
  if (policy.kind !== "events") {
    throw new AiyokeError("INVALID_SPEC", "runtime.profile.observability.kind must be events.");
  }
  if (policy.contentCapture !== "metadata-only" && policy.contentCapture !== "redacted") {
    throw new AiyokeError(
      "INVALID_SPEC",
      "runtime.profile.observability.contentCapture must be metadata-only or redacted."
    );
  }
  return {
    kind: "events",
    contentCapture: policy.contentCapture,
    emitTokenUsage: requiredBoolean(
      policy.emitTokenUsage,
      "runtime.profile.observability.emitTokenUsage"
    ),
    emitEstimatedCost: requiredBoolean(
      policy.emitEstimatedCost,
      "runtime.profile.observability.emitEstimatedCost"
    )
  };
}

function evaluationPolicy(value: unknown): EvaluationPolicy {
  const policy = record(value, "runtime.profile.evaluation");
  if (policy.kind === "offline") {
    allowedKeys(policy, ["kind"], "runtime.profile.evaluation");
    return { kind: "offline" };
  }
  if (policy.kind === "sampled-online") {
    allowedKeys(policy, ["kind", "sampleRate"], "runtime.profile.evaluation");
    return {
      kind: "sampled-online",
      sampleRate: boundedNumber(
        policy.sampleRate,
        "runtime.profile.evaluation.sampleRate",
        0.000_001,
        1
      )
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.evaluation.kind must be offline or sampled-online."
  );
}

function safetyPolicy(value: unknown): SafetyPolicy {
  const policy = record(value, "runtime.profile.safety");
  allowedKeys(policy, ["kind", "humanApproval", "audit"], "runtime.profile.safety");
  if (policy.kind !== "guarded") {
    throw new AiyokeError("INVALID_SPEC", "runtime.profile.safety.kind must be guarded.");
  }
  if (policy.humanApproval !== "disabled" && policy.humanApproval !== "high-impact") {
    throw new AiyokeError(
      "INVALID_SPEC",
      "runtime.profile.safety.humanApproval must be disabled or high-impact."
    );
  }
  if (policy.audit !== "redacted") {
    throw new AiyokeError("INVALID_SPEC", "runtime.profile.safety.audit must be redacted.");
  }
  return { kind: "guarded", humanApproval: policy.humanApproval, audit: "redacted" };
}

function cachePolicy(value: unknown): CachePolicy {
  const policy = record(value, "runtime.profile.performance.cache");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.performance.cache");
    return { kind: "disabled" };
  }
  if (policy.kind === "registered") {
    allowedKeys(policy, ["kind", "namespace"], "runtime.profile.performance.cache");
    return {
      kind: "registered",
      namespace: requiredString(policy.namespace, "runtime.profile.performance.cache.namespace")
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.performance.cache.kind must be disabled or registered."
  );
}

function tokenBudgetPolicy(value: unknown): TokenBudgetPolicy {
  const policy = record(value, "runtime.profile.performance.tokenBudget");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.performance.tokenBudget");
    return { kind: "disabled" };
  }
  if (policy.kind === "limited") {
    allowedKeys(
      policy,
      ["kind", "maxInputTokens", "maxOutputTokens"],
      "runtime.profile.performance.tokenBudget"
    );
    return {
      kind: "limited",
      maxInputTokens: boundedNumber(
        policy.maxInputTokens,
        "runtime.profile.performance.tokenBudget.maxInputTokens",
        1,
        10_000_000,
        true
      ),
      maxOutputTokens: boundedNumber(
        policy.maxOutputTokens,
        "runtime.profile.performance.tokenBudget.maxOutputTokens",
        1,
        10_000_000,
        true
      )
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.performance.tokenBudget.kind must be disabled or limited."
  );
}

function costBudgetPolicy(value: unknown): CostBudgetPolicy {
  const policy = record(value, "runtime.profile.performance.costBudget");
  if (policy.kind === "disabled") {
    allowedKeys(policy, ["kind"], "runtime.profile.performance.costBudget");
    return { kind: "disabled" };
  }
  if (policy.kind === "limited") {
    allowedKeys(policy, ["kind", "maxEstimatedCostUsd"], "runtime.profile.performance.costBudget");
    return {
      kind: "limited",
      maxEstimatedCostUsd: boundedNumber(
        policy.maxEstimatedCostUsd,
        "runtime.profile.performance.costBudget.maxEstimatedCostUsd",
        0.000_001,
        100_000
      )
    };
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "runtime.profile.performance.costBudget.kind must be disabled or limited."
  );
}

function performancePolicy(value: unknown): PerformancePolicy {
  const policy = record(value, "runtime.profile.performance");
  allowedKeys(
    policy,
    ["cache", "tokenBudget", "costBudget", "maxConcurrency", "maxBatchSize"],
    "runtime.profile.performance"
  );
  return {
    cache: cachePolicy(policy.cache),
    tokenBudget: tokenBudgetPolicy(policy.tokenBudget),
    costBudget: costBudgetPolicy(policy.costBudget),
    maxConcurrency: boundedNumber(
      policy.maxConcurrency,
      "runtime.profile.performance.maxConcurrency",
      1,
      1_024,
      true
    ),
    maxBatchSize: boundedNumber(
      policy.maxBatchSize,
      "runtime.profile.performance.maxBatchSize",
      1,
      10_000,
      true
    )
  };
}

function runtimeProfile(value: unknown): RuntimeProfile {
  const profile = record(value, "runtime.profile");
  if (profile.kind === "production") {
    allowedKeys(profile, ["kind"], "runtime.profile");
    return { kind: "production" };
  }
  if (profile.kind === "custom") {
    allowedKeys(
      profile,
      ["kind", "reliability", "observability", "evaluation", "safety", "performance"],
      "runtime.profile"
    );
    return {
      kind: "custom",
      reliability: reliabilityPolicy(profile.reliability),
      observability: observabilityPolicy(profile.observability),
      evaluation: evaluationPolicy(profile.evaluation),
      safety: safetyPolicy(profile.safety),
      performance: performancePolicy(profile.performance)
    };
  }
  throw new AiyokeError("INVALID_SPEC", "runtime.profile.kind must be production or custom.");
}

function runtimeSpec(value: unknown): RuntimeHarnessSpec {
  const runtime = record(value, "runtime");
  if (runtime.kind === "disabled") {
    allowedKeys(runtime, ["kind"], "runtime");
    return { kind: "disabled" };
  }
  if (runtime.kind === "enabled") {
    allowedKeys(runtime, ["kind", "outputDirectory", "profile"], "runtime");
    return {
      kind: "enabled",
      outputDirectory: safeRelativePath(
        requiredString(runtime.outputDirectory, "runtime.outputDirectory")
      ),
      profile: runtimeProfile(runtime.profile)
    };
  }
  throw new AiyokeError("INVALID_SPEC", "runtime.kind must be disabled or enabled.");
}

function targetSpec(value: unknown, index: number): TargetSpec {
  const target = record(value, `targets[${index}]`);
  const kind = requiredString(target.kind, `targets[${index}].kind`);
  const adapter = extensionId(requiredString(target.adapter, `targets[${index}].adapter`));
  const targetSettings = settings(target.settings, `targets[${index}].settings`);

  if (kind === "coding-agent") {
    allowedKeys(target, ["kind", "adapter", "features", "settings"], `targets[${index}]`);
    const features = uniqueNonEmptyStringArray(target.features ?? [], `targets[${index}].features`);
    if (
      !features.every((feature): feature is AgentFeature =>
        AGENT_FEATURES.has(feature as AgentFeature)
      )
    ) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `targets[${index}].features contains an unknown feature.`
      );
    }
    return { kind, adapter, features, settings: targetSettings };
  }
  if (kind === "chat-plugin") {
    allowedKeys(target, ["kind", "adapter", "settings"], `targets[${index}]`);
    return { kind, adapter, settings: targetSettings };
  }
  if (kind === "api-provider") {
    allowedKeys(target, ["kind", "adapter", "protocol", "settings"], `targets[${index}]`);
    const protocol = target.protocol;
    if (protocol !== "responses" && protocol !== "chat-completions") {
      throw new AiyokeError(
        "INVALID_SPEC",
        `targets[${index}].protocol must be responses or chat-completions.`
      );
    }
    return { kind, adapter, protocol, settings: targetSettings };
  }
  if (kind === "inference-gateway") {
    allowedKeys(target, ["kind", "adapter", "routing", "settings"], `targets[${index}]`);
    const routing = record(target.routing, `targets[${index}].routing`);
    const routeKind = routing.kind;
    if (routeKind === "fixed") {
      allowedKeys(routing, ["kind", "model"], `targets[${index}].routing`);
      return {
        kind,
        adapter,
        routing: { kind: routeKind, model: requiredString(routing.model, "routing.model") },
        settings: targetSettings
      };
    }
    if (routeKind === "fallback") {
      allowedKeys(routing, ["kind", "models"], `targets[${index}].routing`);
      const models = uniqueNonEmptyStringArray(routing.models, "routing.models");
      if (models.length === 0) {
        throw new AiyokeError("INVALID_SPEC", "routing.models cannot be empty.");
      }
      return { kind, adapter, routing: { kind: routeKind, models }, settings: targetSettings };
    }
    if (routeKind === "capability") {
      allowedKeys(
        routing,
        ["kind", "requiredParameters", "providerOrder"],
        `targets[${index}].routing`
      );
      return {
        kind,
        adapter,
        routing: {
          kind: routeKind,
          requiredParameters: uniqueNonEmptyStringArray(
            routing.requiredParameters ?? [],
            "routing.requiredParameters"
          ),
          providerOrder: uniqueNonEmptyStringArray(
            routing.providerOrder ?? [],
            "routing.providerOrder"
          )
        },
        settings: targetSettings
      };
    }
    throw new AiyokeError("INVALID_SPEC", `targets[${index}].routing.kind is invalid.`);
  }
  throw new AiyokeError("INVALID_SPEC", `targets[${index}].kind is not supported.`);
}

function parseYaml(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `aiyoke.yaml exceeds the ${MAX_CONFIG_BYTES}-byte limit.`
    );
  }
  let value: unknown;
  try {
    value = parse(source, {
      maxAliasCount: 0,
      merge: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2"
    });
  } catch (error) {
    throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml is not valid YAML.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  return value;
}

export function parseSchemaDocument(source: string): SchemaDocument {
  const root = record(parseYaml(source), "aiyoke.yaml");
  if (!isJsonValue(root)) {
    throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml exceeds JSON safety limits.");
  }
  if (!Number.isSafeInteger(root.schemaVersion) || (root.schemaVersion as number) < 1) {
    throw new AiyokeError("INVALID_SPEC", "schemaVersion must be a positive safe integer.");
  }
  return root as SchemaDocument;
}

export function parseHarnessSpec(source: string): HarnessSpec {
  const root = parseSchemaDocument(source);
  if (root.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `schemaVersion must be ${CURRENT_SCHEMA_VERSION}; run \`aiyoke migrate\` for older configurations.`
    );
  }
  allowedKeys(
    root,
    ["schemaVersion", "project", "composition", "runtime", "targets", "packs", "generation"],
    "aiyoke.yaml"
  );
  const project = record(root.project, "project");
  allowedKeys(project, ["name", "architecture"], "project");
  const architecture = project.architecture;
  if (
    architecture !== "layered" &&
    architecture !== "hexagonal" &&
    architecture !== "clean" &&
    architecture !== "custom"
  ) {
    throw new AiyokeError("INVALID_SPEC", "project.architecture is invalid.");
  }
  const generation = record(root.generation, "generation");
  allowedKeys(generation, ["sourceDirectory", "lockFile", "lineEndings"], "generation");
  if (generation.lineEndings !== "lf") {
    throw new AiyokeError("INVALID_SPEC", "generation.lineEndings must be lf.");
  }
  if (!Array.isArray(root.targets)) {
    throw new AiyokeError("INVALID_SPEC", "targets must be an array.");
  }
  const targets = root.targets.map(targetSpec);
  if (
    new Set(targets.map((target) => `${target.kind}:${target.adapter}`)).size !== targets.length
  ) {
    throw new AiyokeError("INVALID_SPEC", "targets cannot contain duplicate kind/adapter pairs.");
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      name: requiredString(project.name, "project.name"),
      architecture
    },
    composition: compositionSpec(root.composition),
    runtime: runtimeSpec(root.runtime),
    targets,
    packs: idArray(root.packs ?? [], "packs"),
    generation: {
      sourceDirectory: safeRelativePath(
        requiredString(generation.sourceDirectory, "generation.sourceDirectory")
      ),
      lockFile: safeRelativePath(requiredString(generation.lockFile, "generation.lockFile")),
      lineEndings: "lf"
    }
  };
}

export function stringifyHarnessSpec(spec: HarnessSpec): string {
  return stringify(spec, { lineWidth: 0 });
}

export function stringifySchemaDocument(document: SchemaDocument): string {
  return stringify(document, { lineWidth: 0 });
}

export function defaultHarnessSpec(projectName: string): HarnessSpec {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: { name: projectName, architecture: "layered" },
    composition: {
      kind: "single",
      stack: { languages: [extensionId("typescript")], frameworks: [] }
    },
    runtime: DEFAULT_RUNTIME_HARNESS,
    targets: [
      {
        kind: "coding-agent",
        adapter: extensionId("claude-code"),
        features: ["instructions", "skills", "subagents", "hooks", "mcp"],
        settings: {}
      },
      {
        kind: "coding-agent",
        adapter: extensionId("codex"),
        features: ["instructions", "skills", "subagents", "headless"],
        settings: {}
      },
      { kind: "chat-plugin", adapter: extensionId("chatgpt"), settings: {} },
      {
        kind: "coding-agent",
        adapter: extensionId("grok-build"),
        features: ["instructions", "skills", "hooks", "mcp"],
        settings: {}
      },
      {
        kind: "api-provider",
        adapter: extensionId("xai-api"),
        protocol: "responses",
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: extensionId("openrouter"),
        routing: {
          kind: "capability",
          requiredParameters: ["tools", "structured_outputs"],
          providerOrder: ["openai", "anthropic", "xai"]
        },
        settings: {}
      }
    ],
    packs: [extensionId("engineering")],
    generation: {
      sourceDirectory: ".aiyoke/source",
      lockFile: ".aiyoke/lock.json",
      lineEndings: "lf"
    }
  };
}
