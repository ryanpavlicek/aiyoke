import type { BuiltinDiagnosticDefinition } from "../core/index.js";

const stable = "stable" as const;

export const BUILTIN_DIAGNOSTIC_CATALOG: readonly BuiltinDiagnosticDefinition[] = Object.freeze([
  {
    channel: "error",
    code: "ARTIFACT_CONFLICT",
    summary: "Generated artifacts have incompatible ownership or content.",
    remediation: "Inspect the reported paths and remove or reconfigure the conflicting producer.",
    stability: stable
  },
  {
    channel: "error",
    code: "EXTENSION_API_MISMATCH",
    summary: "An extension targets an incompatible extension API version.",
    remediation: "Install a compatible extension release or update its declared API version.",
    stability: stable
  },
  {
    channel: "error",
    code: "EXTENSION_CONFLICT",
    summary: "Selected extensions declare a conflict.",
    remediation: "Remove one of the conflicting extensions from the configuration.",
    stability: stable
  },
  {
    channel: "error",
    code: "EXTENSION_CYCLE",
    summary: "The extension dependency graph contains a cycle.",
    remediation: "Break the reported dependency cycle before resolving the registry.",
    stability: stable
  },
  {
    channel: "error",
    code: "EXTENSION_DUPLICATE",
    summary: "An extension kind and ID were registered more than once.",
    remediation: "Register exactly one loader for each extension kind and ID.",
    stability: stable
  },
  {
    channel: "error",
    code: "EXTENSION_MISSING",
    summary: "A selected or required extension is not registered.",
    remediation: "Register the missing extension or remove its reference from the configuration.",
    stability: stable
  },
  {
    channel: "error",
    code: "INVALID_PATH",
    summary: "A path is unsafe or invalid on a supported platform.",
    remediation: "Use a normalized repository-relative path without traversal or reserved names.",
    stability: stable
  },
  {
    channel: "error",
    code: "INVALID_SPEC",
    summary: "Configuration or command input violates the supported schema or contract.",
    remediation: "Correct the reported field or command option and retry validation.",
    stability: stable
  },
  {
    channel: "error",
    code: "PLAN_CONFLICT",
    summary: "A plan is conflicted or stale and cannot be applied safely.",
    remediation: "Resolve conflicts, create a fresh plan, review it, and apply that plan.",
    stability: stable
  },
  {
    channel: "error",
    code: "REGISTRY_FROZEN",
    summary: "Code attempted to modify a registry after composition was finalized.",
    remediation: "Register all extensions before freezing or resolving the registry.",
    stability: stable
  },
  {
    channel: "error",
    code: "UNEXPECTED",
    summary: "The CLI caught an error outside Aiyoke's structured error contract.",
    remediation: "Capture the command and sanitized output, then report a reproducible defect.",
    stability: stable
  },
  {
    channel: "error",
    code: "VALIDATION_FAILED",
    summary: "A bounded validation step rejected data or generated output.",
    remediation:
      "Inspect the validation details and correct the rejected input or extension output.",
    stability: stable
  },
  {
    channel: "error",
    code: "WORKSPACE_IO",
    summary: "A workspace read or atomic write could not be completed safely.",
    remediation: "Check permissions and path state, then create a new plan before retrying.",
    stability: stable
  },
  {
    channel: "finding",
    code: "ARTIFACT_CONFLICT",
    defaultSeverity: "error",
    summary: "Multiple producers or ownership rules conflict for an artifact.",
    remediation: "Inspect the path and sources, then remove or reconfigure one producer.",
    stability: stable
  },
  {
    channel: "finding",
    code: "ARTIFACT_MISSING",
    defaultSeverity: "warning",
    summary: "A target-specific artifact expected by verification is absent.",
    remediation: "Run plan and apply, then check the target configuration if it remains absent.",
    stability: stable
  },
  {
    channel: "finding",
    code: "EMPTY_FALLBACK_MODEL",
    defaultSeverity: "error",
    summary: "An OpenRouter fallback route contains a blank model ID.",
    remediation: "Replace blank entries with valid model IDs or remove them.",
    stability: stable
  },
  {
    channel: "finding",
    code: "EMPTY_FALLBACK_ROUTE",
    defaultSeverity: "error",
    summary: "An OpenRouter fallback route contains no models.",
    remediation: "Configure at least one fallback model.",
    stability: stable
  },
  {
    channel: "finding",
    code: "EMPTY_FIXED_ROUTE",
    defaultSeverity: "error",
    summary: "An OpenRouter fixed route has a blank model ID.",
    remediation: "Configure a nonblank model ID.",
    stability: stable
  },
  {
    channel: "finding",
    code: "EMPTY_PROVIDER_ORDER",
    defaultSeverity: "error",
    summary: "An OpenRouter capability route has no provider preference.",
    remediation: "Configure at least one provider in deterministic preference order.",
    stability: stable
  },
  {
    channel: "finding",
    code: "GENERATED_DRIFT",
    defaultSeverity: "error",
    summary: "A generated artifact differs from the canonical configuration.",
    remediation: "Review a fresh plan and apply it, or update aiyoke.yaml intentionally.",
    stability: stable
  },
  {
    channel: "finding",
    code: "INVALID_OPENROUTER_PROTOCOL",
    defaultSeverity: "error",
    summary: "The OpenRouter target is configured with an unsupported protocol.",
    remediation: "Use the supported OpenRouter inference-gateway configuration.",
    stability: stable
  },
  {
    channel: "finding",
    code: "NO_LANGUAGES",
    defaultSeverity: "warning",
    summary: "The project selects no language extensions.",
    remediation: "Run detection or select at least one supported language.",
    stability: stable
  },
  {
    channel: "finding",
    code: "NO_TARGETS",
    defaultSeverity: "error",
    summary: "The project selects no AI target adapters.",
    remediation: "Select at least one supported target before generation.",
    stability: stable
  },
  {
    channel: "finding",
    code: "READY",
    defaultSeverity: "info",
    summary: "Doctor found no readiness or synchronization errors.",
    remediation: "No action is required.",
    stability: stable
  },
  {
    channel: "finding",
    code: "TARGET_ADAPTER_MISMATCH",
    defaultSeverity: "error",
    summary: "A target specification names a different adapter than its verifier.",
    remediation: "Select the adapter matching the generated target artifacts.",
    stability: stable
  },
  {
    channel: "finding",
    code: "TARGET_KIND_MISMATCH",
    defaultSeverity: "error",
    summary: "A target specification uses an incompatible target surface kind.",
    remediation: "Use the target kind declared by the selected adapter.",
    stability: stable
  }
]);
