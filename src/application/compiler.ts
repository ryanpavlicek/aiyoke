import {
  AiyokeError,
  type ArtifactIntent,
  compareCodePoints,
  type HarnessModule,
  type HarnessPlan,
  type HarnessSpec,
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
  TargetExtension
} from "../extension-sdk/index.js";
import type { HashPort, WorkspacePort } from "./ports.js";

export interface ApplyResult {
  readonly plan: HarnessPlan;
  readonly changedPaths: readonly string[];
}

function normalizeContent(content: string): string {
  return `${content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/, "")}\n`;
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
    executable: operation.artifact.executable,
    source: operation.artifact.source
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
    const candidates: ArtifactIntent[] = [];

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

    const manifestArtifacts = candidates
      .map((artifact) => ({
        path: safeRelativePath(artifact.path),
        digest: this.hash.digest(normalizeContent(artifact.content)),
        source: artifact.source
      }))
      .sort((left, right) => compareCodePoints(left.path, right.path));
    candidates.push({
      path: spec.generation.lockFile,
      content: JSON.stringify(
        {
          schemaVersion: 1,
          specDigest: this.hash.digest(JSON.stringify(spec)),
          artifacts: manifestArtifacts
        },
        undefined,
        2
      ),
      ownership: "generated",
      source: "aiyoke",
      executable: false
    });

    const operations = await this.#operations(candidates);
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

    const changedPaths: string[] = [];
    for (const operation of plan.operations) {
      if (operation.kind !== "create" && operation.kind !== "update") continue;
      await this.workspace.writeAtomic(
        operation.artifact.path,
        operation.artifact.content,
        operation.artifact.executable
      );
      changedPaths.push(operation.artifact.path);
    }
    return { plan, changedPaths };
  }

  async verify(spec: HarnessSpec): Promise<readonly VerificationFinding[]> {
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
    const references: ExtensionReference[] = [
      ...spec.stack.languages.map((id) => ({ kind: "language" as const, id })),
      ...spec.stack.frameworks.map((id) => ({ kind: "framework" as const, id })),
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

  async #operations(candidates: readonly ArtifactIntent[]): Promise<readonly PlanOperation[]> {
    const byPath = new Map<string, ArtifactIntent[]>();
    for (const candidate of candidates) {
      const normalized: ArtifactIntent = {
        ...candidate,
        path: safeRelativePath(candidate.path),
        content: normalizeContent(candidate.content)
      };
      const current = byPath.get(normalized.path) ?? [];
      current.push(normalized);
      byPath.set(normalized.path, current);
    }

    const operations: PlanOperation[] = [];
    for (const path of [...byPath.keys()].sort()) {
      const intents = byPath.get(path);
      if (intents === undefined || intents.length === 0) continue;
      const first = intents[0];
      if (first === undefined) continue;
      const incompatible = intents.some(
        (intent) =>
          intent.content !== first.content ||
          intent.executable !== first.executable ||
          intent.ownership !== first.ownership
      );
      if (incompatible) {
        operations.push({
          kind: "conflict",
          path,
          reason: `Multiple extensions produced incompatible content for ${path}.`,
          sources: [...new Set(intents.map((intent) => intent.source))].sort()
        });
        continue;
      }

      const previous = await this.workspace.read(path);
      if (previous === undefined) {
        operations.push({ kind: "create", artifact: first });
      } else if (normalizeContent(previous) === first.content) {
        operations.push({ kind: "unchanged", artifact: first });
      } else if (first.ownership === "generated") {
        operations.push({ kind: "update", artifact: first, previous });
      } else {
        operations.push({
          kind: "conflict",
          path,
          reason: `${path} is ${first.ownership}; aiyoke will not replace existing content.`,
          sources: [...new Set(intents.map((intent) => intent.source))].sort()
        });
      }
    }
    return operations;
  }
}
