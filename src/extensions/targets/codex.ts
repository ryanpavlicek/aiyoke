import {
  type ArtifactIntent,
  compareCodePoints,
  type VerificationFinding
} from "../../core/index.js";
import type {
  TargetExtension,
  TargetRenderContext,
  TargetVerificationContext
} from "../../extension-sdk/index.js";
import { artifact, renderInstructions, renderSkill, uniqueSkills } from "../shared/render.js";
import {
  descriptor,
  loaderFor,
  type TargetImplementation,
  verifyTarget
} from "../shared/target.js";

const ADAPTER = "codex";

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const intents: ArtifactIntent[] = [
    artifact("AGENTS.md", renderInstructions(context.modules, "Project instructions"), ADAPTER, {
      ownership: "managed-section"
    })
  ];
  for (const { module, name } of uniqueSkills(context.modules)) {
    intents.push(
      artifact(
        `.agents/skills/${name}/SKILL.md`,
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

export const codexTarget: TargetExtension = {
  descriptor: descriptor(
    ADAPTER,
    "Codex",
    "Native AGENTS.md instructions and .agents skills for Codex.",
    ["instructions", "skills", "subagents", "headless"]
  ),
  surface: "coding-agent",
  render,
  verify
};

export function createCodexLoader() {
  return loaderFor(codexTarget as TargetImplementation);
}

export const codexLoader = createCodexLoader();
