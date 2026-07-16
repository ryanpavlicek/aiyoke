import {
  type ArtifactIntent,
  type HarnessModule,
  type HarnessSpec,
  safeRelativePath,
  type TargetSpec,
  type VerificationFinding
} from "../core/index.js";
import type {
  AiyokeExtension,
  CapabilityPackExtension,
  ExtensionLoader,
  FrameworkExtension,
  LanguageExtension,
  RuntimeScope,
  RuntimeTemplateExtension,
  TargetExtension,
  WorkspaceSnapshot
} from "./contracts.js";
import { ExtensionRegistry } from "./registry.js";

export type CompatibilityCheckId =
  | "descriptor"
  | "dependencies"
  | "loader-identity"
  | "execution"
  | "determinism"
  | "artifact-safety"
  | "secret-safety";

export interface CompatibilityCheck {
  readonly id: CompatibilityCheckId;
  readonly status: "passed" | "failed";
}

export interface CompatibilityFinding {
  readonly check: CompatibilityCheckId;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface CompatibilityFixture {
  readonly spec: HarnessSpec;
  readonly files?: Readonly<Record<string, string>>;
  readonly modules?: readonly HarnessModule[];
  readonly target?: TargetSpec;
  readonly runtimeScope?: RuntimeScope;
  readonly secretCanaries?: readonly string[];
  readonly maxOutputBytes?: number;
}

export interface CompatibilityRunOptions {
  readonly loader: ExtensionLoader;
  readonly dependencies?: readonly ExtensionLoader[];
  readonly fixture: CompatibilityFixture;
}

export type CompatibilityReport =
  | {
      readonly kind: "passed";
      readonly extension: string;
      readonly checks: readonly CompatibilityCheck[];
      readonly findings: readonly [];
    }
  | {
      readonly kind: "failed";
      readonly extension: string;
      readonly checks: readonly CompatibilityCheck[];
      readonly findings: readonly CompatibilityFinding[];
    };

type CompatibilityOutput =
  | {
      readonly kind: "module";
      readonly detection?: { readonly confidence: number; readonly reasons: readonly string[] };
      readonly module: HarnessModule;
    }
  | {
      readonly kind: "target";
      readonly artifacts: readonly ArtifactIntent[];
      readonly verification: readonly VerificationFinding[];
    }
  | { readonly kind: "runtime"; readonly artifacts: readonly ArtifactIntent[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function redact(message: string, canaries: readonly string[]): string {
  return canaries.reduce(
    (safe, canary) => (canary.length === 0 ? safe : safe.split(canary).join("[REDACTED]")),
    message
  );
}

function errorMessage(error: unknown, canaries: readonly string[]): string {
  return redact(error instanceof Error ? error.message : String(error), canaries);
}

function snapshot(files: Readonly<Record<string, string>>): WorkspaceSnapshot {
  const entries = new Map(Object.entries(files));
  return Object.freeze({
    root: "/compatibility-fixture",
    files: Object.freeze([...entries.keys()].sort()),
    async read(path: string) {
      return entries.get(path);
    },
    async exists(path: string) {
      return entries.has(path);
    }
  });
}

function artifacts(output: CompatibilityOutput): readonly ArtifactIntent[] {
  return output.kind === "module" ? [] : output.artifacts;
}

async function execute(
  extension: AiyokeExtension,
  fixture: CompatibilityFixture,
  workspace: WorkspaceSnapshot
): Promise<CompatibilityOutput> {
  const context = { spec: fixture.spec, workspace };
  switch (extension.descriptor.kind) {
    case "language":
    case "framework": {
      const detectable = extension as LanguageExtension | FrameworkExtension;
      const detection = await detectable.detect(workspace);
      if (
        !Number.isFinite(detection.confidence) ||
        detection.confidence < 0 ||
        detection.confidence > 1 ||
        !detection.reasons.every((reason) => typeof reason === "string")
      ) {
        throw new TypeError("Detection must return confidence in [0, 1] and string reasons.");
      }
      return { kind: "module", detection, module: await detectable.contribute(context) };
    }
    case "pack": {
      const pack = extension as CapabilityPackExtension;
      return { kind: "module", module: await pack.contribute(context) };
    }
    case "target": {
      const targetExtension = extension as TargetExtension;
      if (fixture.target === undefined)
        throw new TypeError("Target extensions require fixture.target.");
      if (fixture.target.adapter !== extension.descriptor.id) {
        throw new TypeError("fixture.target adapter must match the extension id.");
      }
      if (fixture.target.kind !== targetExtension.surface) {
        throw new TypeError("fixture.target surface must match the target extension.");
      }
      const targetContext = {
        ...context,
        target: fixture.target,
        modules: fixture.modules ?? []
      };
      return {
        kind: "target",
        artifacts: await targetExtension.render(targetContext),
        verification: await targetExtension.verify({ ...context, target: fixture.target })
      };
    }
    case "runtime": {
      const runtimeExtension = extension as RuntimeTemplateExtension;
      if (fixture.runtimeScope === undefined) {
        throw new TypeError("Runtime extensions require fixture.runtimeScope.");
      }
      if (fixture.spec.runtime.kind !== "enabled") {
        throw new TypeError("Runtime extensions require an enabled runtime fixture.");
      }
      return {
        kind: "runtime",
        artifacts: await runtimeExtension.render({
          ...context,
          runtime: fixture.spec.runtime,
          scope: fixture.runtimeScope
        })
      };
    }
  }
}

function validateDescriptor(loader: ExtensionLoader): void {
  const descriptor = loader.descriptor;
  if (descriptor.version.trim().length === 0) throw new TypeError("Extension version is required.");
  if (descriptor.displayName.trim().length === 0) {
    throw new TypeError("Extension displayName is required.");
  }
  if (descriptor.description.trim().length === 0) {
    throw new TypeError("Extension description is required.");
  }
  if (!descriptor.capabilities.every((capability) => capability.trim().length > 0)) {
    throw new TypeError("Extension capabilities must be non-empty strings.");
  }
}

function validateOutput(output: CompatibilityOutput, maxOutputBytes: number): void {
  const encoded = new TextEncoder().encode(canonical(output));
  if (encoded.byteLength > maxOutputBytes) {
    throw new RangeError(`Extension output exceeded ${maxOutputBytes} bytes.`);
  }
  if (output.kind === "module") {
    if (
      output.module.id.trim().length === 0 ||
      output.module.title.trim().length === 0 ||
      output.module.source.trim().length === 0
    ) {
      throw new TypeError("Contributed modules require id, title, and source.");
    }
  }
  const paths = new Set<string>();
  for (const artifact of artifacts(output)) {
    const path = safeRelativePath(artifact.path);
    if (path !== artifact.path.replaceAll("\\", "/")) {
      throw new TypeError(`Artifact path must already be normalized: ${artifact.path}`);
    }
    if (paths.has(path)) throw new TypeError(`Artifact path is duplicated: ${path}`);
    paths.add(path);
    if (artifact.content.includes("\r")) {
      throw new TypeError(`Artifact must use LF line endings: ${path}`);
    }
  }
}

export async function runExtensionCompatibility(
  options: CompatibilityRunOptions
): Promise<CompatibilityReport> {
  const checks = new Map<CompatibilityCheckId, "passed" | "failed">();
  const findings: CompatibilityFinding[] = [];
  const canaries = options.fixture.secretCanaries ?? [];
  const fail = (check: CompatibilityCheckId, code: string, error: unknown, path?: string) => {
    checks.set(check, "failed");
    findings.push({
      check,
      code,
      message: errorMessage(error, canaries),
      ...(path === undefined ? {} : { path })
    });
  };
  const pass = (check: CompatibilityCheckId) => {
    if (checks.get(check) !== "failed") checks.set(check, "passed");
  };

  try {
    validateDescriptor(options.loader);
    pass("descriptor");
  } catch (error) {
    fail("descriptor", "INVALID_DESCRIPTOR", error);
  }

  let extension: AiyokeExtension | undefined;
  try {
    const registry = new ExtensionRegistry();
    for (const dependency of options.dependencies ?? []) registry.register(dependency);
    registry.register(options.loader).freeze();
    pass("dependencies");
    extension = await registry.get(options.loader.descriptor);
    if (canonical(extension.descriptor) !== canonical(options.loader.descriptor)) {
      throw new TypeError("Loaded extension descriptor does not match the loader descriptor.");
    }
    pass("loader-identity");
  } catch (error) {
    if (!checks.has("dependencies")) fail("dependencies", "DEPENDENCY_GRAPH_INVALID", error);
    else fail("loader-identity", "LOADER_IDENTITY_INVALID", error);
  }

  let first: CompatibilityOutput | undefined;
  let second: CompatibilityOutput | undefined;
  try {
    if (extension === undefined) throw new TypeError("Extension could not be loaded.");
    const files = options.fixture.files ?? {};
    for (const path of Object.keys(files)) safeRelativePath(path);
    const workspace = snapshot(files);
    first = await execute(extension, options.fixture, workspace);
    second = await execute(extension, options.fixture, workspace);
    validateOutput(first, options.fixture.maxOutputBytes ?? 1024 * 1024);
    validateOutput(second, options.fixture.maxOutputBytes ?? 1024 * 1024);
    pass("execution");
    pass("artifact-safety");
  } catch (error) {
    fail("execution", "EXTENSION_EXECUTION_FAILED", error);
    fail("artifact-safety", "UNSAFE_EXTENSION_OUTPUT", error);
  }

  if (first !== undefined && second !== undefined) {
    if (canonical(first) === canonical(second)) pass("determinism");
    else fail("determinism", "NONDETERMINISTIC_OUTPUT", "Repeated output differs.");
    const serialized = canonical(first);
    const leaked = canaries.find((canary) => canary.length > 0 && serialized.includes(canary));
    if (leaked === undefined) pass("secret-safety");
    else fail("secret-safety", "SECRET_CANARY_LEAKED", "A secret canary appeared in output.");
  } else {
    fail("determinism", "DETERMINISM_NOT_TESTED", "Extension execution did not complete.");
    fail("secret-safety", "SECRET_SAFETY_NOT_TESTED", "Extension execution did not complete.");
  }

  const orderedIds: readonly CompatibilityCheckId[] = [
    "descriptor",
    "dependencies",
    "loader-identity",
    "execution",
    "determinism",
    "artifact-safety",
    "secret-safety"
  ];
  const reportChecks = orderedIds.map((id) => ({ id, status: checks.get(id) ?? "failed" }));
  const extensionKey = `${options.loader.descriptor.kind}:${options.loader.descriptor.id}`;
  return findings.length === 0
    ? { kind: "passed", extension: extensionKey, checks: reportChecks, findings: [] }
    : { kind: "failed", extension: extensionKey, checks: reportChecks, findings };
}
