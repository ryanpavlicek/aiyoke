#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extensionId } from "../dist/core/index.js";
import {
  chatGptTarget,
  claudeCodeTarget,
  codexTarget,
  grokBuildTarget,
  openRouterTarget,
  xaiApiTarget
} from "../dist/extensions/targets/index.js";

const native = process.argv.includes("--native");
const root = await mkdtemp(join(tmpdir(), "aiyoke-target-validation-"));
const versions = JSON.parse(
  await readFile(new URL("./target-client-versions.json", import.meta.url), "utf8")
);
const secretCanary = "aiyoke-secret-canary-must-never-be-written";
const PINNED_GROK_BUILD_VERSION = "0.2.101";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`
  );
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys ${actual.join(", ")} do not match ${expected.join(", ")}.`
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: false,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}).\n${output}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function runPnpmDlx(packageName, version, args, options = {}) {
  const pnpm = process.env.npm_execpath;
  if (pnpm !== undefined && pnpm.length > 0) {
    return run(
      process.execPath,
      [pnpm, `--package=${packageName}@${version}`, "dlx", ...args],
      options
    );
  }
  return run(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [`--package=${packageName}@${version}`, "dlx", ...args],
    options
  );
}

const moduleFixture = {
  id: "target-client-contract",
  title: "Target client contract",
  source: "target-client-fixture",
  instructions: [
    {
      kind: "always",
      id: "downward-dependencies",
      title: "Downward dependencies",
      body: ["Keep the stable core independent from adapters."]
    }
  ],
  skills: [
    {
      name: "verify-change",
      description: "Verify a repository change with evidence.",
      body: "Inspect the change and run focused verification.",
      userInvocable: true,
      allowedTools: ["read", "search", "test"]
    }
  ],
  hooks: [
    { id: "guard-shell", event: "pre-tool", matcher: "Bash", command: "node scripts/guard.mjs" }
  ],
  mcpServers: [
    {
      name: "remote",
      transport: {
        kind: "http",
        url: "https://mcp.example.com/mcp",
        bearerTokenEnvironmentVariable: "MCP_TOKEN"
      }
    }
  ],
  subagents: [
    {
      name: "reviewer",
      description: "Review changes without modifying files.",
      prompt: "Return evidence-backed findings.",
      tools: ["read", "search"],
      readOnly: true
    }
  ]
};

const baseSpec = {
  schemaVersion: 3,
  project: { name: "Aiyoke fixture", architecture: "layered" },
  composition: { kind: "single", stack: { languages: [], frameworks: [] } },
  runtime: { kind: "disabled" },
  targets: [],
  packs: [],
  generation: { sourceDirectory: ".aiyoke", lockFile: ".aiyoke/lock.json", lineEndings: "lf" }
};

const definitions = [
  {
    id: "claude-code",
    renderer: claudeCodeTarget,
    target: {
      kind: "coding-agent",
      adapter: extensionId("claude-code"),
      features: ["instructions", "skills", "hooks", "mcp", "subagents"],
      settings: {}
    }
  },
  {
    id: "codex",
    renderer: codexTarget,
    target: {
      kind: "coding-agent",
      adapter: extensionId("codex"),
      features: ["instructions", "skills"],
      settings: {}
    }
  },
  {
    id: "chatgpt",
    renderer: chatGptTarget,
    target: {
      kind: "chat-plugin",
      adapter: extensionId("chatgpt"),
      settings: { version: "0.3.0", apiKey: secretCanary }
    }
  },
  {
    id: "grok-build",
    renderer: grokBuildTarget,
    target: {
      kind: "coding-agent",
      adapter: extensionId("grok-build"),
      features: ["instructions", "skills", "hooks", "mcp"],
      settings: {}
    }
  },
  {
    id: "openrouter",
    renderer: openRouterTarget,
    target: {
      kind: "inference-gateway",
      adapter: extensionId("openrouter"),
      routing: { kind: "fallback", models: ["openai/gpt-5.6", "x-ai/grok-4.5"] },
      settings: { protocol: "responses", apiKey: secretCanary }
    }
  },
  {
    id: "xai-api",
    renderer: xaiApiTarget,
    target: {
      kind: "api-provider",
      adapter: extensionId("xai-api"),
      protocol: "responses",
      settings: { apiKey: secretCanary }
    }
  }
];

async function renderFixture(definition) {
  const fixture = join(root, definition.id);
  await mkdir(fixture, { recursive: true });
  const spec = { ...baseSpec, targets: [definition.target] };
  const artifacts = await definition.renderer.render({
    spec,
    target: definition.target,
    modules: [moduleFixture],
    workspace: { root: fixture, files: [], read: async () => undefined, exists: async () => false }
  });
  for (const artifact of artifacts) {
    assert(
      !artifact.path.includes("..") && !artifact.path.startsWith("/"),
      `Unsafe artifact path ${artifact.path}.`
    );
    assert(
      artifact.content.endsWith("\n") && !artifact.content.includes("\r"),
      `${artifact.path} is not LF-normalized.`
    );
    assert(
      !artifact.content.includes(secretCanary),
      `${artifact.path} contains the secret canary.`
    );
    const destination = resolve(fixture, artifact.path);
    assert(
      destination.startsWith(`${resolve(fixture)}${process.platform === "win32" ? "\\" : "/"}`),
      `Artifact escaped fixture: ${artifact.path}.`
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, artifact.content, "utf8");
  }
  run("git", ["init", "--quiet"], { cwd: fixture });
  return fixture;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertSkill(content, label) {
  assert(
    /^---\nname: [a-z0-9-]+\ndescription: .+\n/m.test(content),
    `${label} lacks valid skill frontmatter.`
  );
  assert(
    content.includes("allowed-tools: Bash, Glob, Grep, Read"),
    `${label} lacks translated tool names.`
  );
}

async function validateClaude(fixture) {
  assert(
    (await readFile(join(fixture, "CLAUDE.md"), "utf8")).includes("@AGENTS.md"),
    "Claude instructions do not import AGENTS.md."
  );
  assertSkill(
    await readFile(join(fixture, ".claude", "skills", "verify-change", "SKILL.md"), "utf8"),
    "Claude skill"
  );
  const agent = await readFile(join(fixture, ".claude", "agents", "reviewer.md"), "utf8");
  assert(agent.includes("tools: Glob, Grep, Read"), "Claude subagent tools are not native names.");
  assert(
    agent.includes("permissionMode: plan") && !agent.includes("read-only:"),
    "Claude read-only subagent does not use permissionMode plan."
  );
  const settings = await json(join(fixture, ".claude", "settings.json"));
  exactKeys(settings, ["hooks"], "Claude settings");
  exactKeys(settings.hooks, ["PreToolUse"], "Claude hooks");
  assert(
    settings.hooks.PreToolUse[0].hooks[0].type === "command",
    "Claude command hook is malformed."
  );
  const mcp = await json(join(fixture, ".mcp.json"));
  assert(mcp.mcpServers.remote.type === "http", "Claude remote MCP transport lacks type=http.");
  assert(
    mcp.mcpServers.remote.headers.Authorization === "Bearer $" + "{MCP_TOKEN}",
    "Claude MCP authorization is not environment-expanded."
  );
}

async function validateCodex(fixture) {
  assert(
    (await readFile(join(fixture, "AGENTS.md"), "utf8")).includes("Downward dependencies"),
    "Codex instructions are missing."
  );
  assertSkill(
    await readFile(join(fixture, ".agents", "skills", "verify-change", "SKILL.md"), "utf8"),
    "Codex skill"
  );
}

async function validateChatGpt(fixture) {
  const pluginRoot = join(fixture, ".aiyoke", "generated", "plugins", "aiyoke-project");
  const manifest = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  exactKeys(
    manifest,
    ["description", "hooks", "interface", "mcpServers", "name", "skills", "version"],
    "ChatGPT plugin manifest"
  );
  assert(
    manifest.name === "aiyoke-project" && manifest.version === "0.3.0",
    "ChatGPT plugin identity is invalid."
  );
  assert(
    manifest.skills === "./skills/" &&
      manifest.hooks === "./hooks/hooks.json" &&
      manifest.mcpServers === "./.mcp.json",
    "ChatGPT component paths are invalid."
  );
  const marketplace = await json(join(fixture, ".agents", "plugins", "marketplace.json"));
  exactKeys(marketplace, ["interface", "name", "plugins"], "ChatGPT marketplace");
  const entry = marketplace.plugins[0];
  exactKeys(entry, ["category", "name", "policy", "source"], "ChatGPT marketplace entry");
  assert(
    entry.source.source === "local" &&
      entry.source.path === "./.aiyoke/generated/plugins/aiyoke-project",
    "ChatGPT marketplace source is invalid."
  );
  assert(
    entry.policy.installation === "AVAILABLE" && entry.policy.authentication === "ON_INSTALL",
    "ChatGPT install policy is invalid."
  );
  assertSkill(
    await readFile(join(pluginRoot, "skills", "verify-change", "SKILL.md"), "utf8"),
    "ChatGPT plugin skill"
  );
  assert(
    (await readFile(join(pluginRoot, "skills", "project-guidance", "SKILL.md"), "utf8")).includes(
      "Downward dependencies"
    ),
    "ChatGPT plugin omitted project guidance."
  );
}

async function validateGrok(fixture) {
  assertSkill(
    await readFile(join(fixture, ".grok", "skills", "verify-change", "SKILL.md"), "utf8"),
    "Grok skill"
  );
  const hooks = await json(join(fixture, ".grok", "hooks", "aiyoke.json"));
  assert(
    hooks.hooks.PreToolUse[0].hooks[0].command === "node scripts/guard.mjs",
    "Grok hook is malformed."
  );
  const config = await readFile(join(fixture, ".grok", "config.toml"), "utf8");
  assert(
    config.includes('[mcp_servers."remote"]') &&
      config.includes('headers = { "Authorization" = "Bearer $' + '{MCP_TOKEN}" }'),
    "Grok MCP configuration is malformed."
  );
}

async function validateProviders(fixtures) {
  const openRouter = await json(join(fixtures.get("openrouter"), ".openrouter", "config.json"));
  exactKeys(
    openRouter,
    [
      "apiKeyEnvironmentVariable",
      "baseUrl",
      "protocol",
      "provider",
      "routing",
      "schemaVersion",
      "settings"
    ],
    "OpenRouter config"
  );
  assert(
    openRouter.baseUrl === "https://openrouter.ai/api/v1" &&
      openRouter.apiKeyEnvironmentVariable === "OPENROUTER_API_KEY",
    "OpenRouter endpoint or credential port is invalid."
  );
  const xai = await json(join(fixtures.get("xai-api"), ".xai", "provider.json"));
  exactKeys(
    xai,
    ["apiKeyEnvironmentVariable", "baseUrl", "protocol", "provider", "schemaVersion", "settings"],
    "xAI config"
  );
  assert(
    xai.baseUrl === "https://api.x.ai/v1" && xai.apiKeyEnvironmentVariable === "XAI_API_KEY",
    "xAI endpoint or credential port is invalid."
  );
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function downloadGrok(destination) {
  assert(
    versions.grokBuild.version === PINNED_GROK_BUILD_VERSION,
    "Grok Build manifest and trusted download version differ."
  );
  const platform =
    process.arch === "x64" && process.platform === "linux"
      ? { source: versions.grokBuild.linuxX64, artifact: "linux-x86_64" }
      : process.arch === "x64" && process.platform === "win32"
        ? { source: versions.grokBuild.windowsX64, artifact: "windows-x86_64.exe" }
        : undefined;
  assert(
    platform !== undefined,
    "Pinned Grok native validation supports Linux and Windows x64; use contract validation on other platforms."
  );
  const trustedUrl = `https://x.ai/cli/grok-${PINNED_GROK_BUILD_VERSION}-${platform.artifact}`;
  assert(platform.source.url === trustedUrl, "Grok download URL is outside the trusted pin.");
  assert(/^[a-f0-9]{64}$/u.test(platform.source.sha256), "Grok SHA-256 pin is malformed.");
  const response = await fetch(trustedUrl, { signal: AbortSignal.timeout(180_000) });
  assert(response.ok && response.body !== null, `Grok download failed: ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
  assert(
    (await sha256(destination)) === platform.source.sha256,
    "Pinned Grok binary SHA-256 did not match."
  );
  await chmod(destination, 0o755);
}

async function validateNative(fixtures) {
  const clientHome = join(root, "client-home");
  await mkdir(clientHome, { recursive: true });
  const quietEnvironment = {
    HOME: clientHome,
    USERPROFILE: clientHome,
    CODEX_HOME: join(clientHome, ".codex"),
    GROK_HOME: join(clientHome, ".grok"),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  await mkdir(quietEnvironment.CODEX_HOME, { recursive: true });
  await mkdir(quietEnvironment.GROK_HOME, { recursive: true });

  const claudeVersion = runPnpmDlx(
    versions.claudeCode.package,
    versions.claudeCode.version,
    ["claude", "--version"],
    { env: quietEnvironment }
  );
  assert(
    claudeVersion.includes(versions.claudeCode.version),
    "Claude Code did not report the pinned version."
  );
  runPnpmDlx(
    versions.claudeCode.package,
    versions.claudeCode.version,
    ["claude", "mcp", "get", "remote"],
    { cwd: fixtures.get("claude-code"), env: quietEnvironment }
  );

  const codexVersion = runPnpmDlx(
    versions.codex.package,
    versions.codex.version,
    ["codex", "--version"],
    { env: quietEnvironment }
  );
  assert(codexVersion.includes(versions.codex.version), "Codex did not report the pinned version.");
  const addedMarketplace = runPnpmDlx(
    versions.codex.package,
    versions.codex.version,
    ["codex", "plugin", "marketplace", "add", fixtures.get("chatgpt"), "--json"],
    { cwd: fixtures.get("chatgpt"), env: quietEnvironment }
  );
  assert(
    addedMarketplace.includes('"marketplaceName": "aiyoke-projects"'),
    "Codex did not accept the generated ChatGPT marketplace."
  );
  const marketplaces = runPnpmDlx(
    versions.codex.package,
    versions.codex.version,
    ["codex", "plugin", "marketplace", "list"],
    { cwd: fixtures.get("chatgpt"), env: quietEnvironment }
  );
  assert(
    marketplaces.includes("aiyoke-projects"),
    "Codex did not discover the generated ChatGPT marketplace."
  );

  const grok = join(root, process.platform === "win32" ? "grok.exe" : "grok");
  await downloadGrok(grok);
  const grokVersion = run(grok, ["version"], { env: quietEnvironment });
  assert(
    grokVersion.includes(versions.grokBuild.version),
    "Grok Build did not report the pinned version."
  );
  const inspected = JSON.parse(
    run(grok, ["inspect", "--json"], {
      cwd: fixtures.get("grok-build"),
      env: quietEnvironment
    }).trim()
  );
  assert(
    inspected.projectInstructions.some((entry) => entry.fileType === "agents_md"),
    "Grok Build did not discover generated AGENTS.md instructions."
  );
  assert(
    inspected.skills.some(
      (entry) => entry.name === "verify-change" && entry.source?.type === "project"
    ),
    "Grok Build did not discover the generated project skill."
  );
  assert(
    inspected.mcpServers.some(
      (entry) => entry.name === "remote" && entry.target === "https://mcp.example.com/mcp"
    ),
    "Grok Build did not discover the generated MCP endpoint."
  );
  assert(
    inspected.configSources.layers.some((entry) => entry.role === "project"),
    "Grok Build did not load the generated project configuration layer."
  );
}

try {
  const fixtures = new Map();
  for (const definition of definitions)
    fixtures.set(definition.id, await renderFixture(definition));
  await validateClaude(fixtures.get("claude-code"));
  await validateCodex(fixtures.get("codex"));
  await validateChatGpt(fixtures.get("chatgpt"));
  await validateGrok(fixtures.get("grok-build"));
  await validateProviders(fixtures);
  if (native) await validateNative(fixtures);
  process.stdout.write(
    `All target artifacts passed contract validation${native ? " and pinned native-client probes" : ""}.\n`
  );
} catch (error) {
  process.stderr.write(`Preserved failed target fixture at ${root}.\n`);
  throw error;
}

if (process.env.AIYOKE_KEEP_TARGET_FIXTURE === "1") {
  process.stdout.write(`Preserved target fixture at ${root}.\n`);
} else {
  const resolved = resolve(root);
  assert(
    resolve(dirname(resolved)) === resolve(tmpdir()),
    `Refusing to remove target fixture outside ${tmpdir()}.`
  );
  assert(
    basename(resolved).startsWith("aiyoke-target-validation-"),
    `Refusing to remove unexpected target fixture ${resolved}.`
  );
  await rm(resolved, { recursive: true, force: true });
}
