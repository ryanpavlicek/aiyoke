import {
  type ArtifactIntent,
  compareCodePoints,
  type JsonValue,
  type VerificationFinding
} from "../../core/index.js";
import type {
  TargetExtension,
  TargetRenderContext,
  TargetVerificationContext
} from "../../extension-sdk/index.js";
import {
  artifact,
  renderHooks,
  renderInstructions,
  renderMcpServers,
  renderSkill,
  sanitizeObject,
  stableJson,
  uniqueSkills
} from "../shared/render.js";
import {
  descriptor,
  loaderFor,
  type TargetImplementation,
  verifyTarget
} from "../shared/target.js";

const ADAPTER = "grok-build";

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const targetSettings =
    context.target.kind === "coding-agent" ? sanitizeObject(context.target.settings) : {};
  const claudeSelected = context.spec.targets.some((target) => target.adapter === "claude-code");
  const skillEntries = claudeSelected ? [] : uniqueSkills(context.modules);
  const settings = {
    ...targetSettings,
    schemaVersion: 1,
    project: context.spec.project.name,
    instructions: "GROK.md",
    skills: skillEntries.map(({ name }) => `.grok/skills/${name}/SKILL.md`),
    hooks: renderHooks(context.modules).hooks,
    mcp: renderMcpServers(context.modules)
  } as unknown as JsonValue;
  const intents: ArtifactIntent[] = [
    artifact("GROK.md", renderInstructions(context.modules, "Grok Build instructions"), ADAPTER, {
      ownership: "managed-section"
    }),
    artifact(".grok/config.json", stableJson(settings), ADAPTER)
  ];
  for (const { module, name } of skillEntries) {
    intents.push(
      artifact(
        `.grok/skills/${name}/SKILL.md`,
        renderSkill(module, name),
        `${ADAPTER}:${module.id}`
      )
    );
  }
  return intents.sort((a, b) => compareCodePoints(a.path, b.path));
}

async function verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]> {
  return verifyTarget(context, ADAPTER, "coding-agent");
}

export const grokBuildTarget: TargetExtension = {
  descriptor: descriptor(
    ADAPTER,
    "Grok Build",
    "Native Grok Build project configuration and skills.",
    ["instructions", "skills", "hooks", "mcp"]
  ),
  surface: "coding-agent",
  render,
  verify
};

export function createGrokBuildLoader() {
  return loaderFor(grokBuildTarget as TargetImplementation);
}

export const createGrokBuildTargetLoader = createGrokBuildLoader;
export const grokBuildLoader = createGrokBuildLoader();
export const grokBuildTargetLoader = grokBuildLoader;

export default createGrokBuildLoader;
