import {
  type ArtifactIntent,
  compareCodePoints,
  type HarnessModule,
  type HookDefinition,
  type JsonValue,
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

const GROK_HOOK_EVENTS: Readonly<Record<HookDefinition["event"], string>> = {
  "session-start": "SessionStart",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
  stop: "Stop"
};

function uniqueHooks(modules: readonly HarnessModule[]): readonly HookDefinition[] {
  const hooks: HookDefinition[] = [];
  const seen = new Set<string>();
  for (const hook of modules
    .flatMap((module) => module.hooks)
    .sort((left, right) => compareCodePoints(left.id, right.id))) {
    if (seen.has(hook.id)) continue;
    seen.add(hook.id);
    hooks.push(hook);
  }
  return hooks;
}

function renderGrokHooks(modules: readonly HarnessModule[]): string | undefined {
  const grouped: Record<string, JsonValue[]> = {};
  for (const hook of uniqueHooks(modules)) {
    const event = GROK_HOOK_EVENTS[hook.event];
    const entries = grouped[event] ?? [];
    entries.push({
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      hooks: [{ type: "command", command: hook.command }]
    });
    grouped[event] = entries;
  }
  if (Object.keys(grouped).length === 0) return undefined;
  return stableJson({ hooks: grouped });
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

export const createGrokBuildTargetLoader = createGrokBuildLoader;
export const grokBuildLoader = createGrokBuildLoader();
export const grokBuildTargetLoader = grokBuildLoader;

export default createGrokBuildLoader;
