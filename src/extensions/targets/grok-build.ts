import {
  type ArtifactIntent,
  compareCodePoints,
  type HarnessModule,
  type McpServerDefinition,
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
  renderHooks,
  renderInstructions,
  renderSkill,
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

function renderGrokHooks(modules: readonly HarnessModule[]): string | undefined {
  const hooks = renderHooks(modules);
  if (Object.keys(hooks.hooks as object).length === 0) return undefined;
  return stableJson(hooks);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function uniqueMcpServers(modules: readonly HarnessModule[]): readonly McpServerDefinition[] {
  const servers: McpServerDefinition[] = [];
  const seen = new Set<string>();
  for (const server of modules
    .flatMap((module) => module.mcpServers)
    .sort((left, right) => compareCodePoints(left.name, right.name))) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    servers.push(server);
  }
  return servers;
}

function renderGrokMcpConfig(modules: readonly HarnessModule[]): string | undefined {
  const sections: string[] = [];
  for (const server of uniqueMcpServers(modules)) {
    const lines = [`[mcp_servers.${tomlString(server.name)}]`];
    if (server.transport.kind === "stdio") {
      lines.push(`command = ${tomlString(server.transport.command)}`);
      lines.push(`args = [${server.transport.args.map(tomlString).join(", ")}]`);
    } else {
      lines.push(`url = ${tomlString(server.transport.url)}`);
      if (server.transport.bearerTokenEnvironmentVariable !== undefined) {
        const authorization = `Bearer \${${server.transport.bearerTokenEnvironmentVariable}}`;
        lines.push(`headers = { "Authorization" = ${tomlString(authorization)} }`);
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.length === 0 ? undefined : `${sections.join("\n\n")}\n`;
}

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  assertUniqueModuleDefinitions(context.modules);
  const claudeSelected = context.spec.targets.some((target) => target.adapter === "claude-code");
  const skillEntries = claudeSelected ? [] : uniqueSkills(context.modules);
  const intents: ArtifactIntent[] = [
    artifact("AGENTS.md", renderInstructions(context.modules, "Project instructions"), ADAPTER, {
      ownership: "managed-section"
    })
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

  // Grok reads Claude's hooks and MCP configuration directly. Avoid registering the
  // same executable behavior twice when both native targets are selected.
  if (!claudeSelected) {
    const hooks = renderGrokHooks(context.modules);
    if (hooks !== undefined) intents.push(artifact(".grok/hooks/aiyoke.json", hooks, ADAPTER));
    const mcp = renderGrokMcpConfig(context.modules);
    if (mcp !== undefined) intents.push(artifact(".grok/config.toml", mcp, ADAPTER));
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
    "Native AGENTS.md instructions, skills, hooks, and MCP configuration for Grok Build.",
    ["instructions", "skills", "hooks", "mcp"]
  ),
  surface: "coding-agent",
  render,
  verify
};

export function createGrokBuildLoader() {
  return loaderFor(grokBuildTarget as TargetImplementation);
}

export const grokBuildLoader = createGrokBuildLoader();
