import type {
  ArtifactIntent,
  ArtifactOwnership,
  HarnessModule,
  HookDefinition,
  JsonObject,
  JsonValue,
  ManagedSectionMarkers
} from "../../core/index.js";
import { compareCodePoints, safeRelativePath } from "../../core/index.js";

/** Return a JSON string with object keys sorted recursively for reproducible output. */
export function stableJson(value: JsonValue, indent = 2): string {
  const normalize = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (input !== null && typeof input === "object") {
      const result = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(input).sort(compareCodePoints)) {
        result[key] = normalize(input[key] as JsonValue);
      }
      return result;
    }
    return input;
  };
  return `${JSON.stringify(normalize(value), null, indent)}\n`;
}

/** Sort and de-duplicate strings without mutating the caller's data. */
export function stableStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

/**
 * Convert a value that looks like a secret into an environment-variable reference.
 * Generated files must never contain API keys or bearer tokens. Existing env references
 * are preserved, while all other sensitive values are represented as `${ENV_VAR}`.
 */
export function sanitizeJson(value: JsonValue, parentKey = ""): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, parentKey));
  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      result[key] = sanitizeJson(value[key] as JsonValue, key);
    }
    return result;
  }
  if (typeof value !== "string") return value;
  if (/(environmentvariable|env)$/i.test(parentKey) && /^[A-Z][A-Z0-9_]*$/.test(value)) {
    return value;
  }
  const sensitive = /(api[-_]?key|secret|token|password|credential|authorization|bearer)/i.test(
    parentKey
  );
  if (!sensitive || value.startsWith("${") || value.startsWith("$ENV(")) return value;
  const env = parentKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  // Never derive an environment name from the secret itself.
  return `\${${env || "AIYOKE_SECRET"}}`;
}

export function sanitizeObject(value: JsonObject): JsonObject {
  return sanitizeJson(value) as JsonObject;
}

const DEFAULT_MANAGED_MARKERS: ManagedSectionMarkers = {
  start: "<!-- aiyoke:managed:start -->",
  end: "<!-- aiyoke:managed:end -->"
};

export type ArtifactOptions =
  | {
      readonly ownership?: Exclude<ArtifactOwnership, "managed-section">;
      readonly executable?: boolean;
    }
  | {
      readonly ownership: "managed-section";
      readonly executable?: boolean;
      readonly markers?: ManagedSectionMarkers;
    };

export function artifact(
  path: string,
  content: string,
  source: string,
  options: ArtifactOptions = {}
): ArtifactIntent {
  const base = {
    path: safeRelativePath(path),
    content: content.endsWith("\n") ? content : `${content}\n`,
    source,
    executable: options.executable ?? false
  };
  if (options.ownership === "managed-section") {
    return {
      ...base,
      ownership: "managed-section",
      markers: options.markers ?? DEFAULT_MANAGED_MARKERS
    };
  }
  return { ...base, ownership: options.ownership ?? "generated" };
}

function markdownLines(module: HarnessModule): string[] {
  const lines: string[] = [`## ${module.title}`, "", `> Generated from ${module.source}.`, ""];
  for (const block of module.instructions) {
    lines.push(`### ${block.title}`);
    if (block.kind === "path-scoped") {
      lines.push(`Paths: ${stableStrings(block.paths).join(", ")}`);
    }
    lines.push("", ...block.body, "");
  }
  return lines;
}

/** Render all instruction blocks in deterministic module/id order. */
export function renderInstructions(modules: readonly HarnessModule[], title: string): string {
  const lines = [`# ${title}`, "", "<!-- aiyoke:generated -->", ""];
  for (const module of [...modules].sort((a, b) => compareCodePoints(a.id, b.id))) {
    lines.push(...markdownLines(module));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSkill(module: HarnessModule, skillName: string): string {
  const skills = module.skills.filter((skill) => skill.name === skillName);
  const skill = skills[0];
  if (skill === undefined) return "";
  const lines = [
    `---`,
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `user-invocable: ${skill.userInvocable ? "true" : "false"}`,
    `allowed-tools: ${nativeToolNames(skill.allowedTools).join(", ")}`,
    `---`,
    "",
    skill.body.trimEnd()
  ];
  return `${lines.join("\n")}\n`;
}

const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  test: ["Bash"],
  shell: ["Bash"],
  write: ["Edit", "Write"]
};

/** Translate portable module capabilities into tool names shared by coding clients. */
export function nativeToolNames(tools: readonly string[]): readonly string[] {
  return stableStrings(tools.flatMap((tool) => TOOL_ALIASES[tool.toLowerCase()] ?? [tool]));
}

export function uniqueSkills(
  modules: readonly HarnessModule[]
): readonly { module: HarnessModule; name: string }[] {
  const result: { module: HarnessModule; name: string }[] = [];
  const seen = new Set<string>();
  for (const module of [...modules].sort((a, b) => compareCodePoints(a.id, b.id))) {
    for (const skill of [...module.skills].sort((a, b) => compareCodePoints(a.name, b.name))) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      result.push({ module, name: skill.name });
    }
  }
  return result;
}

export function renderHooks(modules: readonly HarnessModule[]): JsonObject {
  const eventNames: Readonly<Record<HookDefinition["event"], string>> = {
    "session-start": "SessionStart",
    "pre-tool": "PreToolUse",
    "post-tool": "PostToolUse",
    stop: "Stop"
  };
  const hooks: Record<string, JsonValue[]> = {};
  const seen = new Set<string>();
  for (const hook of modules
    .flatMap((module) => module.hooks)
    .sort((a, b) => compareCodePoints(a.id, b.id))) {
    if (seen.has(hook.id)) continue;
    seen.add(hook.id);
    const event = eventNames[hook.event];
    const entries = hooks[event] ?? [];
    entries.push({
      ...(hook.matcher === undefined || hook.event === "stop" ? {} : { matcher: hook.matcher }),
      hooks: [{ type: "command", command: hook.command }]
    });
    hooks[event] = entries;
  }
  return { hooks } as unknown as JsonObject;
}

export function renderMcpServers(modules: readonly HarnessModule[]): JsonObject {
  const servers: Record<string, JsonValue> = {};
  for (const server of modules
    .flatMap((module) => module.mcpServers)
    .sort((a, b) => compareCodePoints(a.name, b.name))) {
    if (servers[server.name] !== undefined) continue;
    servers[server.name] =
      server.transport.kind === "stdio"
        ? { type: "stdio", command: server.transport.command, args: [...server.transport.args] }
        : {
            type: "http",
            url: server.transport.url,
            ...(server.transport.bearerTokenEnvironmentVariable === undefined
              ? {}
              : {
                  headers: {
                    Authorization: `Bearer \${${server.transport.bearerTokenEnvironmentVariable}}`
                  }
                })
          };
  }
  return { mcpServers: servers } as unknown as JsonObject;
}

export function targetMatches(
  contextTarget: { readonly adapter: string },
  adapter: string
): boolean {
  return contextTarget.adapter === adapter;
}
