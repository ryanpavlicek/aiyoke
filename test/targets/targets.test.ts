import { describe, expect, it } from "vitest";
import {
  extensionId,
  type HarnessModule,
  type HarnessSpec,
  type TargetSpec
} from "../../src/core/index.js";
import {
  chatGptTarget,
  claudeCodeTarget,
  codexTarget,
  grokBuildTarget,
  openRouterTarget,
  xaiApiTarget
} from "../../src/extensions/targets/index.js";

const moduleFixture: HarnessModule = {
  id: "core",
  title: "Core guidance",
  source: "test",
  instructions: [{ kind: "always", id: "always", title: "Do this", body: ["Be deterministic."] }],
  skills: [
    {
      name: "review",
      description: "Review changes",
      body: "Review the diff.",
      userInvocable: true,
      allowedTools: ["Read"]
    }
  ],
  hooks: [],
  mcpServers: [],
  subagents: []
};

const baseSpec: HarnessSpec = {
  schemaVersion: 3,
  project: { name: "demo", architecture: "clean" },
  composition: { kind: "single", stack: { languages: [], frameworks: [] } },
  runtime: { kind: "disabled" },
  targets: [],
  packs: [],
  generation: { sourceDirectory: ".aiyoke", lockFile: ".aiyoke/lock.json", lineEndings: "lf" }
};

function context(target: TargetSpec, spec: HarnessSpec = baseSpec) {
  return {
    spec,
    target,
    modules: [moduleFixture],
    workspace: { root: ".", files: [], read: async () => undefined, exists: async () => false }
  };
}

describe("target renderers", () => {
  it("renders Claude's AGENTS import and deterministic skills", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("claude-code"),
      features: ["instructions", "skills"],
      settings: {}
    } as const;
    const first = await claudeCodeTarget.render(context(target));
    const second = await claudeCodeTarget.render(context(target));
    expect(first).toEqual(second);
    expect(first.find((artifact) => artifact.path === "CLAUDE.md")?.content).toContain(
      "@AGENTS.md"
    );
    expect(first.some((artifact) => artifact.path === ".claude/skills/review/SKILL.md")).toBe(true);
  });

  it("keeps the minimal Claude artifact set golden", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("claude-code"),
      features: ["instructions", "skills"],
      settings: {}
    } as const;
    const artifacts = await claudeCodeTarget.render(context(target));
    expect(artifacts.map((entry) => entry.path)).toMatchInlineSnapshot(`
      [
        ".claude/skills/review/SKILL.md",
        "AGENTS.md",
        "CLAUDE.md",
      ]
    `);
  });

  it("uses AGENTS.md and .agents skills for Codex", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("codex"),
      features: ["instructions", "skills"],
      settings: {}
    } as const;
    const artifacts = await codexTarget.render(context(target));
    expect(artifacts.map((artifact) => artifact.path)).toContain("AGENTS.md");
    expect(artifacts.map((artifact) => artifact.path)).toContain(".agents/skills/review/SKILL.md");
  });

  it("emits a versionable plugin marketplace", async () => {
    const target = {
      kind: "chat-plugin",
      adapter: extensionId("chatgpt"),
      settings: { version: "2.0.0" }
    } as const;
    const artifacts = await chatGptTarget.render(context(target));
    expect(artifacts.map((artifact) => artifact.path)).toContain(
      ".agents/plugins/marketplace.json"
    );
    const manifest = artifacts.find((artifact) =>
      artifact.path.endsWith(".codex-plugin/plugin.json")
    );
    expect(manifest?.content).toContain('"version": "2.0.0"');
  });

  it("does not duplicate Grok skills when Claude is selected", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("grok-build"),
      features: ["instructions", "skills"],
      settings: {}
    } as const;
    const spec = {
      ...baseSpec,
      targets: [
        { kind: "coding-agent", adapter: extensionId("claude-code"), features: [], settings: {} },
        target
      ]
    } as HarnessSpec;
    const artifacts = await grokBuildTarget.render(context(target, spec));
    expect(artifacts.some((artifact) => artifact.path.includes(".grok/skills/"))).toBe(false);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(["AGENTS.md"]);
  });

  it("uses Grok Build's current native instructions, skills, hooks, and MCP formats", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("grok-build"),
      features: ["instructions", "skills", "hooks", "mcp"],
      settings: {}
    } as const;
    const grokModule: HarnessModule = {
      ...moduleFixture,
      hooks: [{ id: "safety", event: "pre-tool", matcher: "Bash", command: "bin/safety-check" }],
      mcpServers: [
        {
          name: "filesystem",
          transport: { kind: "stdio", command: "npx", args: ["-y", "mcp-filesystem"] }
        },
        {
          name: "remote",
          transport: {
            kind: "http",
            url: "https://mcp.example.com",
            bearerTokenEnvironmentVariable: "MCP_TOKEN"
          }
        }
      ]
    };
    const artifacts = await grokBuildTarget.render({
      ...context(target),
      modules: [grokModule]
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      ".grok/config.toml",
      ".grok/hooks/aiyoke.json",
      ".grok/skills/review/SKILL.md",
      "AGENTS.md"
    ]);
    expect(artifacts.some((artifact) => artifact.path === "GROK.md")).toBe(false);
    expect(artifacts.some((artifact) => artifact.path === ".grok/config.json")).toBe(false);
    expect(
      artifacts.find((artifact) => artifact.path === ".grok/hooks/aiyoke.json")?.content
    ).toContain('"PreToolUse"');
    const config = artifacts.find((artifact) => artifact.path === ".grok/config.toml")?.content;
    expect(config).toContain('[mcp_servers."filesystem"]');
    expect(config).toContain('headers = { "Authorization" = "Bearer $' + '{MCP_TOKEN}" }');
  });

  it("defaults OpenRouter to chat completions and supports Responses opt-in", async () => {
    const fixed = {
      kind: "inference-gateway",
      adapter: extensionId("openrouter"),
      routing: { kind: "fixed", model: "openai/gpt-4o" },
      settings: {}
    } as const;
    const response = { ...fixed, settings: { protocol: "responses" } } as const;
    const defaultArtifact = (await openRouterTarget.render(context(fixed))).at(0);
    const responseArtifact = (await openRouterTarget.render(context(response))).at(0);
    expect(defaultArtifact?.content).toContain('"protocol": "chat-completions"');
    expect(responseArtifact?.content).toContain('"protocol": "responses"');
  });

  it("never writes an xAI API secret", async () => {
    const target = {
      kind: "api-provider",
      adapter: extensionId("xai-api"),
      protocol: "chat-completions",
      settings: { apiKey: "value-that-must-not-appear" }
    } as const;
    const artifacts = await xaiApiTarget.render(context(target));
    expect(artifacts[0]?.content).not.toContain("value-that-must-not-appear");
    expect(artifacts[0]?.content).toContain("${" + "API_KEY}");
  });
});
