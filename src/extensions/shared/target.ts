import type { ArtifactIntent, TargetSpec, VerificationFinding } from "../../core/index.js";
import { compareCodePoints, extensionId } from "../../core/index.js";
import type {
  ExtensionDescriptor,
  ExtensionLoader,
  TargetExtension,
  TargetRenderContext,
  TargetVerificationContext
} from "../../extension-sdk/index.js";

export function descriptor(
  id: string,
  displayName: string,
  description: string,
  capabilities: readonly string[] = []
): ExtensionDescriptor & { readonly kind: "target" } {
  return {
    kind: "target",
    id: extensionId(id),
    version: "1.0.0",
    apiVersion: "1.0.0",
    displayName,
    description,
    capabilities: [...capabilities].sort(compareCodePoints),
    requires: [],
    conflicts: []
  };
}

export function verifyTarget(
  context: TargetVerificationContext,
  adapter: string,
  kind: TargetSpec["kind"]
): readonly VerificationFinding[] {
  const target = context.target;
  if (target.adapter !== adapter) {
    return [
      {
        severity: "error",
        code: "TARGET_ADAPTER_MISMATCH",
        message: `Target adapter is ${target.adapter}; expected ${adapter}.`,
        target: adapter
      }
    ];
  }
  if (target.kind !== kind) {
    return [
      {
        severity: "error",
        code: "TARGET_KIND_MISMATCH",
        message: `Target kind is ${target.kind}; expected ${kind}.`,
        target: adapter
      }
    ];
  }
  return [];
}

export async function verifyArtifacts(
  context: TargetVerificationContext,
  adapter: string,
  kind: TargetSpec["kind"],
  paths: readonly string[]
): Promise<readonly VerificationFinding[]> {
  const findings = [...verifyTarget(context, adapter, kind)];
  if (findings.length > 0) return findings;
  for (const path of [...paths].sort(compareCodePoints)) {
    if (!(await context.workspace.exists(path))) {
      findings.push({
        severity: "warning",
        code: "ARTIFACT_MISSING",
        message: `Generated artifact ${path} is missing.`,
        path,
        target: adapter
      });
    }
  }
  return findings;
}

export interface TargetImplementation {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "target" };
  readonly surface: TargetSpec["kind"];
  render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]>;
  verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]>;
}

export function loaderFor(implementation: TargetImplementation): ExtensionLoader<TargetExtension> {
  return {
    descriptor: implementation.descriptor,
    load: async () => implementation
  };
}
