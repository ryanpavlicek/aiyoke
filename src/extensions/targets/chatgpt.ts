import type { ArtifactIntent, JsonObject, VerificationFinding } from "../../core/index.js";
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
  const pluginRoot = ".aiyoke/generated/plugins/aiyoke-project";
  const hooks = renderHooks(context.modules);
  const hasHooks =
    hooks.hooks !== null &&
    typeof hooks.hooks === "object" &&
    !Array.isArray(hooks.hooks) &&
    Object.keys(hooks.hooks).length > 0;
  const mcp = renderMcpServers(context.modules);
  const hasMcp =
    mcp.mcpServers !== undefined &&
    typeof mcp.mcpServers === "object" &&
    mcp.mcpServers !== null &&
    Object.keys(mcp.mcpServers).length > 0;
  const plugin = {
    name: "aiyoke-project",
    version,
    description,
    skills: "./skills/",
    ...(hasHooks ? { hooks: "./hooks/hooks.json" } : {}),
    ...(hasMcp ? { mcpServers: "./.mcp.json" } : {}),
    interface: {
      displayName: name,
      shortDescription: description,
      longDescription: description,
      developerName: "Aiyoke",
      category: "Developer Tools"
    }
  };
  const marketplace = {
    name: "aiyoke-projects",
    interface: { displayName: "Aiyoke project plugins" },
    plugins: [
      {
        name: "aiyoke-project",
        source: { source: "local", path: `./${pluginRoot}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools"
      }
    ]
  };
  const intents: ArtifactIntent[] = [
    artifact(`${pluginRoot}/.codex-plugin/plugin.json`, stableJson(plugin), ADAPTER),
    artifact(
      `${pluginRoot}/skills/project-guidance/SKILL.md`,
      [
        "---",
        "name: project-guidance",
        "description: Apply the generated project architecture and engineering guidance.",
        "---",
        "",
        renderInstructions(context.modules, "Project instructions").trimEnd(),
        ""
      ].join("\n"),
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
  if (hasHooks) {
    intents.push(artifact(`${pluginRoot}/hooks/hooks.json`, stableJson(hooks), ADAPTER));
  }
  if (hasMcp) {
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

export const chatGptLoader = createChatGptLoader();
