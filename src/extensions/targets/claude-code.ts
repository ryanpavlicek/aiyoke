import {
  type ArtifactIntent,
  compareCodePoints,
  type JsonObject,
  type VerificationFinding
} from "../../core/index.js";
import type {
  TargetExtension,
  TargetRenderContext,
  TargetVerificationContext
} from "../../extension-sdk/index.js";
import {
  artifact,
  assertUniqueModuleDefinitions,
  nativeToolNames,
  renderHooks,
  renderInstructions,
  renderMcpServers,
  renderSkill,
  sanitizeObject,
  stableJson,
  uniqueSkills,
  yamlFrontmatterScalar
} from "../shared/render.js";
import {
  descriptor,
  loaderFor,
  type TargetImplementation,
  verifyTarget
} from "../shared/target.js";

const ADAPTER = "claude-code";

function settings(context: TargetRenderContext): JsonObject {
  const target = context.target;
  return target.kind === "coding-agent" ? sanitizeObject(target.settings) : {};
}

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const modules = context.modules;
  assertUniqueModuleDefinitions(modules);
  const intents: ArtifactIntent[] = [
    artifact("AGENTS.md", renderInstructions(modules, "Project instructions"), ADAPTER, {
      ownership: "managed-section"
    }),
    artifact("CLAUDE.md", "# Claude Code\n\n<!-- aiyoke:generated -->\n\n@AGENTS.md\n", ADAPTER, {
      ownership: "managed-section"
    })
  ];

  const skills = uniqueSkills(modules);
  for (const { module, name } of skills) {
    intents.push(
      artifact(
        `.claude/skills/${name}/SKILL.md`,
        renderSkill(module, name),
        `${ADAPTER}:${module.id}`
      )
    );
  }

  const subagents = modules
    .flatMap((module) => module.subagents)
    .sort((a, b) => compareCodePoints(a.name, b.name));
  const seenSubagents = new Set<string>();
  for (const subagent of subagents) {
    if (seenSubagents.has(subagent.name)) continue;
    seenSubagents.add(subagent.name);
    const body = [
      `---`,
      `name: ${yamlFrontmatterScalar(subagent.name)}`,
      `description: ${yamlFrontmatterScalar(subagent.description)}`,
      `tools: ${nativeToolNames(subagent.tools).join(", ")}`,
      ...(subagent.readOnly ? ["permissionMode: plan"] : []),
      `---`,
      "",
      subagent.prompt.trimEnd(),
      ""
    ].join("\n");
    intents.push(artifact(`.claude/agents/${subagent.name}.md`, body, `${ADAPTER}:subagent`));
  }

  const hooks = renderHooks(modules);
  const targetSettings = settings(context);
  const claudeSettings = {
    ...targetSettings,
    ...(hooks.hooks !== null &&
    typeof hooks.hooks === "object" &&
    !Array.isArray(hooks.hooks) &&
    Object.keys(hooks.hooks).length > 0
      ? hooks
      : {})
  } as JsonObject;
  if (Object.keys(claudeSettings).length > 0) {
    intents.push(artifact(".claude/settings.json", stableJson(claudeSettings), ADAPTER));
  }

  const mcp = renderMcpServers(modules);
  if (
    mcp.mcpServers !== undefined &&
    typeof mcp.mcpServers === "object" &&
    mcp.mcpServers !== null &&
    Object.keys(mcp.mcpServers).length > 0
  ) {
    intents.push(artifact(".mcp.json", stableJson(mcp), ADAPTER));
  }
  return intents.sort((a, b) => compareCodePoints(a.path, b.path));
}

async function verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]> {
  return verifyTarget(context, ADAPTER, "coding-agent");
}

export const claudeCodeTarget: TargetExtension = {
  descriptor: descriptor(
    ADAPTER,
    "Claude Code",
    "Native Claude Code project instructions and skills.",
    ["instructions", "skills", "hooks", "mcp", "subagents"]
  ),
  surface: "coding-agent",
  render,
  verify
};

export function createClaudeCodeLoader() {
  return loaderFor(claudeCodeTarget as TargetImplementation);
}

export const claudeCodeLoader = createClaudeCodeLoader();
