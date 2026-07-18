import {
  extensionId,
  type HarnessModule,
  type InstructionBlock,
  type SkillDefinition
} from "../../core/index.js";
import {
  type DetectionResult,
  defineLanguage,
  type ExtensionDescriptor,
  type LanguageExtension,
  type WorkspaceSnapshot
} from "../../extension-sdk/index.js";
import {
  indexWorkspaceFiles,
  matchesPathOrBasename,
  normalizeWorkspacePath
} from "../shared/detection.js";

export { loaderFor } from "../shared/loader.js";

export interface LanguageDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly markerFiles: readonly string[];
  readonly dependencyPatterns?: readonly string[];
  readonly instructions: readonly string[];
  readonly pathPatterns: readonly string[];
  readonly skillName: string;
  readonly skillDescription: string;
  readonly skillBody: string;
}

export async function detectLanguage(
  workspace: WorkspaceSnapshot,
  definition: LanguageDefinition
): Promise<DetectionResult> {
  const { files, originalByNormalized } = indexWorkspaceFiles(workspace);
  const markerSet = new Set(definition.markerFiles.map(normalizeWorkspacePath));
  const markers = files.filter((file) => matchesPathOrBasename(file, markerSet));
  const extensions = new Set(definition.fileExtensions.map((extension) => extension.toLowerCase()));
  const sourceFiles = files.filter((file) => {
    const name = file.split("/").at(-1) ?? "";
    return [...extensions].some((extension) => name.endsWith(extension));
  });
  const reasons: string[] = [];
  let confidence = 0;
  if (markers.length > 0) {
    confidence = 0.95;
    reasons.push(`found ${markers[0]}`);
  }
  if (sourceFiles.length > 0) {
    confidence = Math.max(confidence, markers.length > 0 ? 0.9 : 0.65);
    reasons.push(
      `found ${sourceFiles.length} ${definition.displayName} source file${sourceFiles.length === 1 ? "" : "s"}`
    );
  }
  if (definition.dependencyPatterns && files.includes("package.json")) {
    const packageJson = await workspace.read(
      originalByNormalized.get("package.json") ?? "package.json"
    );
    const contents = packageJson?.toLowerCase() ?? "";
    const matched = definition.dependencyPatterns.find((pattern) =>
      contents.includes(pattern.toLowerCase())
    );
    if (matched !== undefined) {
      confidence = Math.max(confidence, 0.98);
      reasons.push(`package.json references ${matched}`);
    }
  }
  return { confidence, reasons };
}

export function createLanguage(definition: LanguageDefinition): LanguageExtension {
  const descriptor: ExtensionDescriptor & { readonly kind: "language" } = {
    kind: "language",
    id: extensionId(definition.id),
    version: "1.0.0",
    apiVersion: "1.0.0",
    displayName: definition.displayName,
    description: definition.description,
    capabilities: definition.capabilities,
    requires: [],
    conflicts: []
  };
  return defineLanguage({
    descriptor,
    detect: (workspace) => detectLanguage(workspace, definition),
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
          `Apply ${definition.displayName} conventions to these files: keep changes focused, preserve public APIs, and add tests for behavior changes.`
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
        id: `language-${definition.id}`,
        title: `${definition.displayName} language module`,
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
