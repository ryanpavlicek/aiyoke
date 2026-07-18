import {
  extensionId,
  type HarnessModule,
  type InstructionBlock,
  type SkillDefinition
} from "../../core/index.js";
import {
  type DetectionResult,
  defineFramework,
  type ExtensionDescriptor,
  type FrameworkExtension,
  type WorkspaceSnapshot
} from "../../extension-sdk/index.js";
import {
  indexWorkspaceFiles,
  matchesPathOrBasename,
  normalizeWorkspacePath
} from "../shared/detection.js";

export { loaderFor } from "../shared/loader.js";

export interface FrameworkDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly requires: readonly { readonly kind: "language"; readonly id: string }[];
  readonly markerFiles: readonly string[];
  readonly dependencyPatterns: readonly string[];
  readonly sourcePatterns: readonly string[];
  readonly instructions: readonly string[];
  readonly pathPatterns: readonly string[];
  readonly skillName: string;
  readonly skillDescription: string;
  readonly skillBody: string;
}

export async function detectFramework(
  workspace: WorkspaceSnapshot,
  definition: FrameworkDefinition
): Promise<DetectionResult> {
  const { files, originalByNormalized } = indexWorkspaceFiles(workspace);
  const manifestFiles = new Set([
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.py",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.work"
  ]);
  const markerSet = new Set(definition.markerFiles.map(normalizeWorkspacePath));
  const markerCandidates = files.filter((file) => matchesPathOrBasename(file, markerSet));
  const marker =
    markerCandidates.find((file) => !manifestFiles.has(file.split("/").at(-1) ?? "")) ??
    markerCandidates[0];
  const sourcePattern = definition.sourcePatterns
    .map(normalizeWorkspacePath)
    .find((pattern) => files.some((file) => file.endsWith(pattern)));
  const dependencyMarkers = new Set(definition.markerFiles.map(normalizeWorkspacePath));
  const dependencyFiles = files.filter((file) => matchesPathOrBasename(file, dependencyMarkers));
  const reasons: string[] = [];
  let confidence = 0;
  for (const dependencyFile of dependencyFiles) {
    const contents =
      (
        await workspace.read(originalByNormalized.get(dependencyFile) ?? dependencyFile)
      )?.toLowerCase() ?? "";
    const dependency = definition.dependencyPatterns.find((pattern) =>
      contents.includes(pattern.toLowerCase())
    );
    if (dependency !== undefined) {
      confidence = 0.99;
      reasons.push(`${dependencyFile} references ${dependency}`);
      break;
    }
  }
  const markerName = marker?.split("/").at(-1) ?? "";
  if (marker !== undefined && confidence === 0 && !manifestFiles.has(markerName)) {
    confidence = 0.8;
    reasons.push(`found ${marker}`);
  }
  const distinctiveSource =
    sourcePattern?.startsWith("/") === true || sourcePattern?.startsWith(".") === true;
  if (sourcePattern !== undefined && confidence === 0 && distinctiveSource) {
    confidence = 0.55;
    reasons.push(`found files matching ${sourcePattern}`);
  }
  return { confidence, reasons };
}

export function createFramework(definition: FrameworkDefinition): FrameworkExtension {
  const descriptor: ExtensionDescriptor & { readonly kind: "framework" } = {
    kind: "framework",
    id: extensionId(definition.id),
    version: "1.0.0",
    apiVersion: "1.0.0",
    displayName: definition.displayName,
    description: definition.description,
    capabilities: definition.capabilities,
    requires: definition.requires.map((reference) => ({
      kind: reference.kind,
      id: extensionId(reference.id)
    })),
    conflicts: []
  };
  return defineFramework({
    descriptor,
    detect: (workspace) => detectFramework(workspace, definition),
    async contribute(): Promise<HarnessModule> {
      const always: InstructionBlock = {
        kind: "always",
        id: `${definition.id}-guidance`,
        title: `${definition.displayName} engineering guidance`,
        body: definition.instructions
      };
      const scoped: InstructionBlock = {
        kind: "path-scoped",
        id: `${definition.id}-source-guidance`,
        title: `${definition.displayName} source files`,
        paths: definition.pathPatterns,
        body: [
          `Follow ${definition.displayName} lifecycle, routing, and testing conventions in these files; keep framework wiring at the boundary.`
        ]
      };
      const skill: SkillDefinition = {
        name: definition.skillName,
        description: definition.skillDescription,
        body: definition.skillBody,
        userInvocable: true,
        allowedTools: ["read", "search", "edit", "test"]
      };
      return {
        id: `framework-${definition.id}`,
        title: `${definition.displayName} framework module`,
        source: descriptor.id,
        instructions: [always, scoped],
        skills: [skill],
        hooks: [],
        mcpServers: [],
        subagents: []
      };
    }
  });
}
