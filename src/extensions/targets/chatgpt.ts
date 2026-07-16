import type {
  ArtifactIntent,
  JsonObject,
  JsonValue,
  VerificationFinding
} from "../../core/index.js";
import { compareCodePoints } from "../../core/index.js";
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

const ADAPTER = "chatgpt";

function stringSetting(settings: JsonObject, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const targetSettings =
    context.target.kind === "chat-plugin" ? sanitizeObject(context.target.settings) : {};
  const version = stringSetting(targetSettings, "version", "1.0.0");
  const name = stringSetting(targetSettings, "name", context.spec.project.name);
  const description = stringSetting(
    targetSettings,
    "description",
    `${context.spec.project.name} project assistant`
  );
  const skillEntries = uniqueSkills(context.modules).map(({ module, name: skillName }) => {
    const skill = module.skills.find((candidate) => candidate.name === skillName);
    return {
      name: skillName,
      description: skill?.description ?? ""
    };
  });
  const pluginRoot = ".aiyoke/generated/plugins/aiyoke-project";
  // The marketplace is intentionally checked in under .agents so it can be reviewed and
  // consumed by both ChatGPT and Codex tooling. The plugin root is generated and versionable.
  const plugin = {
    schemaVersion: 1,
    id: ADAPTER,
    name,
    version,
    description,
    instructions: "AGENTS.md",
    skills: skillEntries.map((entry) => ({ ...entry, path: `skills/${entry.name}/SKILL.md` })),
    capabilities: ["instructions", "skills", "hooks", "mcp"],
    settings: targetSettings
  } as unknown as JsonValue;
  const marketplace = {
    schemaVersion: 1,
    plugins: [
      {
        id: ADAPTER,
        name,
        version,
        description,
        path: pluginRoot
      }
    ]
  } as unknown as JsonValue;
  const intents: ArtifactIntent[] = [
    artifact(`${pluginRoot}/.codex-plugin/plugin.json`, stableJson(plugin), ADAPTER),
    artifact(
      `${pluginRoot}/AGENTS.md`,
      renderInstructions(context.modules, "Project instructions"),
      ADAPTER
    ),
    artifact(".agents/plugins/marketplace.json", stableJson(marketplace), ADAPTER)
  ];
  for (const { module, name: skillName } of uniqueSkills(context.modules)) {
    intents.push(
      artifact(
        `${pluginRoot}/skills/${skillName}/SKILL.md`,
        renderSkill(module, skillName),
        `${ADAPTER}:${module.id}`
      )
    );
  }
  const hooks = renderHooks(context.modules);
  if (Array.isArray(hooks.hooks) && hooks.hooks.length > 0) {
    intents.push(artifact(`${pluginRoot}/hooks/hooks.json`, stableJson(hooks), ADAPTER));
  }
  const mcp = renderMcpServers(context.modules);
  if (
    mcp.mcpServers !== undefined &&
    typeof mcp.mcpServers === "object" &&
    mcp.mcpServers !== null &&
    Object.keys(mcp.mcpServers).length > 0
  ) {
    intents.push(artifact(`${pluginRoot}/.mcp.json`, stableJson(mcp), ADAPTER));
  }
  return intents.sort((a, b) => compareCodePoints(a.path, b.path));
}

async function verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]> {
  return verifyTarget(context, ADAPTER, "chat-plugin");
}

export const chatGptTarget: TargetExtension = {
  descriptor: descriptor(
    ADAPTER,
    "ChatGPT",
    "Versionable ChatGPT plugin and marketplace manifests.",
    ["instructions", "skills", "marketplace"]
  ),
  surface: "chat-plugin",
  render,
  verify
};

export function createChatGptLoader() {
  return loaderFor(chatGptTarget as TargetImplementation);
}

export const createChatGptTargetLoader = createChatGptLoader;

/** Alias retaining the conventional all-caps product spelling. */
export const chatGPTTarget = chatGptTarget;
export const createChatGPTLoader = createChatGptLoader;
export const createChatGPTTargetLoader = createChatGptLoader;
export const chatGptLoader = createChatGptLoader();
export const chatGPTLoader = chatGptLoader;
export const chatGptTargetLoader = chatGptLoader;
export const chatGPTTargetLoader = chatGptLoader;
export default createChatGptLoader;
