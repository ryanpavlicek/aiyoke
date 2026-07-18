import {
  AiyokeError,
  type ArtifactIntent,
  aggregateHarnessStack,
  canonicalJson,
  compareCodePoints,
  type HarnessModule,
  type HarnessPlan,
  type HarnessSpec,
  moduleDefinitionConflicts,
  type PlanOperation,
  safeRelativePath,
  type VerificationFinding
} from "../core/index.js";
import type {
  AiyokeExtension,
  CapabilityPackExtension,
  ExtensionReference,
  ExtensionRegistry,
  FrameworkExtension,
  LanguageExtension,
  RuntimeScope,
  TargetExtension
} from "../extension-sdk/index.js";
import { extensionArtifactPath } from "./artifact-policy.js";
import type { HashPort, WorkspacePort } from "./ports.js";
import { loadRuntimeTemplate, runtimeTemplateReferences } from "./runtime-selection.js";

export interface ApplyResult {
  readonly plan: HarnessPlan;
  readonly changedPaths: readonly string[];
}

function normalizeContent(content: string, lineEndings: "lf" | "crlf" = "lf"): string {
  const canonical = `${content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/, "")}\n`;
  return lineEndings === "crlf" ? canonical.replaceAll("\n", "\r\n") : canonical;
}

function contributionExtension(
  extension: AiyokeExtension
): LanguageExtension | FrameworkExtension | CapabilityPackExtension | undefined {
  if (
    extension.descriptor.kind === "language" ||
    extension.descriptor.kind === "framework" ||
    extension.descriptor.kind === "pack"
  ) {
    return extension as LanguageExtension | FrameworkExtension | CapabilityPackExtension;
  }
  return undefined;
}

function targetExtension(extension: AiyokeExtension): TargetExtension {
  if (extension.descriptor.kind !== "target") {
    throw new AiyokeError(
      "INVALID_SPEC",
      `Expected target extension, received ${extension.descriptor.kind}:${extension.descriptor.id}.`
    );
  }
  return extension as TargetExtension;
}

function runtimeScopes(spec: HarnessSpec): readonly RuntimeScope[] {
  if (spec.composition.kind === "single") {
    return [{ kind: "project", stack: spec.composition.stack }];
  }
  return [
    { kind: "project", stack: spec.composition.root },
    ...spec.composition.workspaces.map(
      (workspace): RuntimeScope => ({
        kind: "workspace",
        id: workspace.id,
        path: workspace.path,
        stack: workspace.stack
      })
    )
  ];
}

function stableOperation(operation: PlanOperation): object {
  if (operation.kind === "conflict") {
    return {
      kind: operation.kind,
      path: operation.path,
      reason: operation.reason,
      sources: operation.sources
    };
  }
  return {
    kind: operation.kind,
    path: operation.artifact.path,
    content: operation.artifact.content,
    ownership: operation.artifact.ownership,
    ...(operation.artifact.ownership === "managed-section"
      ? { markers: operation.artifact.markers }
      : {}),
    executable: operation.artifact.executable,
    source: operation.artifact.source
  };
}

type ManagedMergeResult =
  | { readonly kind: "merged"; readonly content: string }
  | { readonly kind: "conflict"; readonly reason: string };

function sameManagedMarkers(left: ArtifactIntent, right: ArtifactIntent): boolean {
  if (left.ownership !== "managed-section" || right.ownership !== "managed-section") {
    return left.ownership === right.ownership;
  }
  return left.markers.start === right.markers.start && left.markers.end === right.markers.end;
}

function managedSection(
  artifact: Extract<ArtifactIntent, { ownership: "managed-section" }>,
  lineEndings: "lf" | "crlf"
): string {
  const newline = lineEndings === "crlf" ? "\r\n" : "\n";
  return `${artifact.markers.start}${newline}${artifact.content}${artifact.markers.end}${newline}`;
}

function mergeManagedSection(
  previous: string,
  artifact: Extract<ArtifactIntent, { ownership: "managed-section" }>,
  lineEndings: "lf" | "crlf"
): ManagedMergeResult {
  const { start, end } = artifact.markers;
  if (
    start.length === 0 ||
    end.length === 0 ||
    start === end ||
    start.includes("\n") ||
    end.includes("\n")
  ) {
    return { kind: "conflict", reason: "Managed-section markers must be distinct single lines." };
  }
  if (artifact.content.includes(start) || artifact.content.includes(end)) {
    return { kind: "conflict", reason: "Generated content contains its managed-section marker." };
  }

  const startIndex = previous.indexOf(start);
  const endIndex = previous.indexOf(end);
  if (startIndex === -1 && endIndex === -1) {
    if (normalizeContent(previous, lineEndings) === artifact.content) {
      return { kind: "merged", content: managedSection(artifact, lineEndings) };
    }
    if (previous.includes("<!-- aiyoke:generated -->")) {
      return {
        kind: "conflict",
        reason: "A legacy aiyoke marker exists in modified content; migrate it before applying."
      };
    }
    const newline = lineEndings === "crlf" ? "\r\n" : "\n";
    const separator =
      previous.length === 0 || previous.endsWith("\n\n") || previous.endsWith("\r\n\r\n")
        ? ""
        : previous.endsWith("\n")
          ? newline
          : `${newline}${newline}`;
    return {
      kind: "merged",
      content: `${previous}${separator}${managedSection(artifact, lineEndings)}`
    };
  }

  const hasAmbiguousMarkers =
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex < startIndex ||
    previous.indexOf(start, startIndex + start.length) !== -1 ||
    previous.indexOf(end, endIndex + end.length) !== -1;
  if (hasAmbiguousMarkers) {
    return {
      kind: "conflict",
      reason: "Managed-section markers are missing, duplicated, or out of order."
    };
  }

  let suffixStart = endIndex + end.length;
  if (previous.startsWith("\r\n", suffixStart)) suffixStart += 2;
  else if (previous.startsWith("\n", suffixStart)) suffixStart += 1;
  return {
    kind: "merged",
    content: `${previous.slice(0, startIndex)}${managedSection(artifact, lineEndings)}${previous.slice(suffixStart)}`
  };
}

export class HarnessCompiler {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly workspace: WorkspacePort,
    private readonly hash: HashPort
  ) {}

  async plan(spec: HarnessSpec): Promise<HarnessPlan> {
    const modules = await this.#resolveModules(spec);
    const moduleConflicts = moduleDefinitionConflicts(modules);
    if (moduleConflicts.length > 0) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `Harness modules contain ${moduleConflicts.length} duplicate named definition(s).`,
        {
          conflicts: moduleConflicts.map((conflict) => ({
            kind: conflict.kind,
            name: conflict.name,
            modules: [...conflict.modules]
          }))
        }
      );
    }
    const candidates: ArtifactIntent[] = [];

    if (spec.runtime.kind === "enabled") {
      for (const scope of runtimeScopes(spec)) {
        for (const reference of runtimeTemplateReferences(this.registry, scope.stack.languages)) {
          const runtime = await loadRuntimeTemplate(this.registry, reference);
          candidates.push(
            ...(await runtime.render({
              spec,
              workspace: this.workspace,
              runtime: spec.runtime,
              scope
            }))
          );
        }
      }
    }

    for (const target of spec.targets) {
      const extension = targetExtension(
        await this.registry.get({ kind: "target", id: target.adapter })
      );
      if (extension.surface !== target.kind) {
        throw new AiyokeError(
          "INVALID_SPEC",
          `Target ${target.adapter} supports ${extension.surface}, not ${target.kind}.`
        );
      }
      const rendered = await extension.render({
        spec,
        workspace: this.workspace,
        target,
        modules
      });
      candidates.push(...rendered);
    }

    for (const candidate of candidates) {
      extensionArtifactPath(candidate.path, spec.generation.lockFile);
    }

    const manifestArtifacts = candidates
      .map((artifact) => ({
        path: safeRelativePath(artifact.path),
        digest: this.hash.digest(normalizeContent(artifact.content, spec.generation.lineEndings)),
        source: artifact.source
      }))
      .sort((left, right) => compareCodePoints(left.path, right.path));
    candidates.push({
      path: spec.generation.lockFile,
      content: JSON.stringify(
        {
          schemaVersion: 1,
          specDigest: this.hash.digest(canonicalJson(spec)),
          artifacts: manifestArtifacts
        },
        undefined,
        2
      ),
      ownership: "generated",
      source: "aiyoke",
      executable: false
    });

    const operations = await this.#operations(candidates, spec.generation.lineEndings);
    const fingerprint = this.hash.digest(
      JSON.stringify({
        schemaVersion: spec.schemaVersion,
        operations: operations.map(stableOperation)
      })
    );
    return { spec, operations, fingerprint };
  }

  async apply(plan: HarnessPlan): Promise<ApplyResult> {
    const conflicts = plan.operations.filter((operation) => operation.kind === "conflict");
    if (conflicts.length > 0) {
      throw new AiyokeError(
        "PLAN_CONFLICT",
        `Cannot apply a plan with ${conflicts.length} artifact conflict(s).`,
        { fingerprint: plan.fingerprint, conflicts: conflicts.length }
      );
    }

    for (const operation of plan.operations) {
      if (operation.kind !== "create" && operation.kind !== "update") continue;
      const current = await this.workspace.read(operation.artifact.path);
      const isFresh =
        operation.kind === "create" ? current === undefined : current === operation.previous;
      if (!isFresh) {
        throw new AiyokeError(
          "PLAN_CONFLICT",
          `${operation.artifact.path} changed after this plan was created; create a new plan before applying.`,
          { path: operation.artifact.path, fingerprint: plan.fingerprint }
        );
      }
    }

    const writes = plan.operations.flatMap((operation) =>
      operation.kind === "create" || operation.kind === "update"
        ? [
            {
              path: operation.artifact.path,
              content: operation.artifact.content,
              executable: operation.artifact.executable,
              previous: operation.kind === "update" ? operation.previous : undefined
            }
          ]
        : []
    );
    await this.workspace.writeBatchAtomic(writes);
    const changedPaths = writes.map((write) => write.path);
    return { plan, changedPaths };
  }

  async verify(spec: HarnessSpec): Promise<readonly VerificationFinding[]> {
    const moduleConflicts = moduleDefinitionConflicts(await this.#resolveModules(spec));
    if (moduleConflicts.length > 0) {
      return moduleConflicts.map((conflict) => ({
        severity: "error",
        code: "MODULE_DEFINITION_CONFLICT",
        message: `Duplicate ${conflict.kind} ${conflict.name} is contributed by ${conflict.modules.join(
          ", "
        )}.`
      }));
    }
    const plan = await this.plan(spec);
    const findings: VerificationFinding[] = [];
    for (const operation of plan.operations) {
      if (operation.kind === "create" || operation.kind === "update") {
        findings.push({
          severity: "error",
          code: "GENERATED_DRIFT",
          message: `${operation.artifact.path} is not synchronized with aiyoke.yaml.`,
          path: operation.artifact.path
        });
      } else if (operation.kind === "conflict") {
        findings.push({
          severity: "error",
          code: "ARTIFACT_CONFLICT",
          message: operation.reason,
          path: operation.path
        });
      }
    }

    for (const target of spec.targets) {
      const extension = targetExtension(
        await this.registry.get({ kind: "target", id: target.adapter })
      );
      findings.push(...(await extension.verify({ spec, workspace: this.workspace, target })));
    }

    return findings.sort((left, right) => {
      const leftKey = `${left.severity}:${left.path ?? ""}:${left.code}`;
      const rightKey = `${right.severity}:${right.path ?? ""}:${right.code}`;
      return compareCodePoints(leftKey, rightKey);
    });
  }

  async #resolveModules(spec: HarnessSpec): Promise<readonly HarnessModule[]> {
    const stack = aggregateHarnessStack(spec.composition);
    const references: ExtensionReference[] = [
      ...stack.languages.map((id) => ({ kind: "language" as const, id })),
      ...stack.frameworks.map((id) => ({ kind: "framework" as const, id })),
      ...spec.packs.map((id) => ({ kind: "pack" as const, id }))
    ];
    const resolved = await this.registry.resolve(references);
    const modules: HarnessModule[] = [];
    for (const extension of resolved) {
      const contributor = contributionExtension(extension);
      if (contributor === undefined) continue;
      modules.push(await contributor.contribute({ spec, workspace: this.workspace }));
    }
    return modules.sort((left, right) =>
      compareCodePoints(`${left.source}:${left.id}`, `${right.source}:${right.id}`)
    );
  }

  async #operations(
    candidates: readonly ArtifactIntent[],
    lineEndings: "lf" | "crlf"
  ): Promise<readonly PlanOperation[]> {
    const byPath = new Map<string, ArtifactIntent[]>();
    for (const candidate of candidates) {
      const normalized: ArtifactIntent = {
        ...candidate,
        path: safeRelativePath(candidate.path),
        content: normalizeContent(candidate.content, lineEndings)
      };
      const current = byPath.get(normalized.path) ?? [];
      current.push(normalized);
      byPath.set(normalized.path, current);
    }

    const operations: PlanOperation[] = [];
    for (const path of [...byPath.keys()].sort(compareCodePoints)) {
      const intents = byPath.get(path);
      if (intents === undefined || intents.length === 0) continue;
      const first = intents[0];
      if (first === undefined) continue;
      const incompatible = intents.some(
        (intent) =>
          intent.content !== first.content ||
          intent.executable !== first.executable ||
          intent.ownership !== first.ownership ||
          !sameManagedMarkers(intent, first)
      );
      if (incompatible) {
        operations.push({
          kind: "conflict",
          path,
          reason: `Multiple extensions produced incompatible content for ${path}.`,
          sources: [...new Set(intents.map((intent) => intent.source))].sort(compareCodePoints)
        });
        continue;
      }

      const previous = await this.workspace.read(path);
      if (first.ownership === "managed-section") {
        const merged = mergeManagedSection(previous ?? "", first, lineEndings);
        if (merged.kind === "conflict") {
          operations.push({
            kind: "conflict",
            path,
            reason: `${path}: ${merged.reason}`,
            sources: [...new Set(intents.map((intent) => intent.source))].sort(compareCodePoints)
          });
          continue;
        }
        const effective = { ...first, content: merged.content };
        if (previous === undefined) {
          operations.push({ kind: "create", artifact: effective });
        } else if (previous === effective.content) {
          operations.push({ kind: "unchanged", artifact: effective });
        } else {
          operations.push({ kind: "update", artifact: effective, previous });
        }
      } else if (previous === undefined) {
        operations.push({ kind: "create", artifact: first });
      } else if (normalizeContent(previous, lineEndings) === first.content) {
        operations.push({ kind: "unchanged", artifact: first });
      } else if (first.ownership === "generated") {
        operations.push({ kind: "update", artifact: first, previous });
      } else {
        operations.push({
          kind: "conflict",
          path,
          reason: `${path} is ${first.ownership}; aiyoke will not replace existing content.`,
          sources: [...new Set(intents.map((intent) => intent.source))].sort(compareCodePoints)
        });
      }
    }
    return operations;
  }
}
