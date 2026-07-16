import { parse, stringify } from "yaml";
import {
  type AgentFeature,
  AiyokeError,
  extensionId,
  type HarnessSpec,
  type JsonObject,
  type JsonValue,
  safeRelativePath,
  type TargetSpec
} from "../../core/index.js";

const AGENT_FEATURES = new Set<AgentFeature>([
  "instructions",
  "skills",
  "subagents",
  "hooks",
  "mcp",
  "permissions",
  "headless"
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an array of strings.`);
  }
  return value;
}

function idArray(value: unknown, label: string) {
  const ids = stringArray(value, label).map(extensionId);
  if (new Set(ids).size !== ids.length) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain duplicates.`);
  }
  return ids;
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.entries(value).every(
        ([key, item]) =>
          key !== "__proto__" &&
          key !== "prototype" &&
          key !== "constructor" &&
          isJsonValue(item, ancestors)
      );
  ancestors.delete(value);
  return valid;
}

function settings(value: unknown, label: string): JsonObject {
  const candidate = value ?? {};
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !isJsonValue(candidate)
  ) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a JSON object.`);
  }
  return candidate as JsonObject;
}

function targetSpec(value: unknown, index: number): TargetSpec {
  const target = record(value, `targets[${index}]`);
  const kind = requiredString(target.kind, `targets[${index}].kind`);
  const adapter = extensionId(requiredString(target.adapter, `targets[${index}].adapter`));
  const targetSettings = settings(target.settings, `targets[${index}].settings`);

  if (kind === "coding-agent") {
    const features = stringArray(target.features ?? [], `targets[${index}].features`);
    if (
      !features.every((feature): feature is AgentFeature =>
        AGENT_FEATURES.has(feature as AgentFeature)
      )
    ) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `targets[${index}].features contains an unknown feature.`
      );
    }
    return { kind, adapter, features, settings: targetSettings };
  }
  if (kind === "chat-plugin") return { kind, adapter, settings: targetSettings };
  if (kind === "api-provider") {
    const protocol = target.protocol;
    if (protocol !== "responses" && protocol !== "chat-completions") {
      throw new AiyokeError(
        "INVALID_SPEC",
        `targets[${index}].protocol must be responses or chat-completions.`
      );
    }
    return { kind, adapter, protocol, settings: targetSettings };
  }
  if (kind === "inference-gateway") {
    const routing = record(target.routing, `targets[${index}].routing`);
    const routeKind = routing.kind;
    if (routeKind === "fixed") {
      return {
        kind,
        adapter,
        routing: { kind: routeKind, model: requiredString(routing.model, "routing.model") },
        settings: targetSettings
      };
    }
    if (routeKind === "fallback") {
      const models = stringArray(routing.models, "routing.models");
      if (models.length === 0) {
        throw new AiyokeError("INVALID_SPEC", "routing.models cannot be empty.");
      }
      return { kind, adapter, routing: { kind: routeKind, models }, settings: targetSettings };
    }
    if (routeKind === "capability") {
      return {
        kind,
        adapter,
        routing: {
          kind: routeKind,
          requiredParameters: stringArray(
            routing.requiredParameters ?? [],
            "routing.requiredParameters"
          ),
          providerOrder: stringArray(routing.providerOrder ?? [], "routing.providerOrder")
        },
        settings: targetSettings
      };
    }
    throw new AiyokeError("INVALID_SPEC", `targets[${index}].routing.kind is invalid.`);
  }
  throw new AiyokeError("INVALID_SPEC", `targets[${index}].kind is not supported.`);
}

export function parseHarnessSpec(source: string): HarnessSpec {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml is not valid YAML.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const root = record(value, "aiyoke.yaml");
  if (root.schemaVersion !== 1) {
    throw new AiyokeError("INVALID_SPEC", "schemaVersion must be 1.");
  }
  const project = record(root.project, "project");
  const architecture = project.architecture;
  if (
    architecture !== "layered" &&
    architecture !== "hexagonal" &&
    architecture !== "clean" &&
    architecture !== "custom"
  ) {
    throw new AiyokeError("INVALID_SPEC", "project.architecture is invalid.");
  }
  const stack = record(root.stack, "stack");
  const generation = record(root.generation, "generation");
  if (generation.lineEndings !== "lf") {
    throw new AiyokeError("INVALID_SPEC", "generation.lineEndings must be lf.");
  }
  if (!Array.isArray(root.targets)) {
    throw new AiyokeError("INVALID_SPEC", "targets must be an array.");
  }
  const targets = root.targets.map(targetSpec);
  if (
    new Set(targets.map((target) => `${target.kind}:${target.adapter}`)).size !== targets.length
  ) {
    throw new AiyokeError("INVALID_SPEC", "targets cannot contain duplicate kind/adapter pairs.");
  }

  return {
    schemaVersion: 1,
    project: {
      name: requiredString(project.name, "project.name"),
      architecture
    },
    stack: {
      languages: idArray(stack.languages ?? [], "stack.languages"),
      frameworks: idArray(stack.frameworks ?? [], "stack.frameworks")
    },
    targets,
    packs: idArray(root.packs ?? [], "packs"),
    generation: {
      sourceDirectory: safeRelativePath(
        requiredString(generation.sourceDirectory, "generation.sourceDirectory")
      ),
      lockFile: safeRelativePath(requiredString(generation.lockFile, "generation.lockFile")),
      lineEndings: "lf"
    }
  };
}

export function stringifyHarnessSpec(spec: HarnessSpec): string {
  return stringify(spec, { lineWidth: 0 });
}

export function defaultHarnessSpec(projectName: string): HarnessSpec {
  return {
    schemaVersion: 1,
    project: { name: projectName, architecture: "layered" },
    stack: { languages: [extensionId("typescript")], frameworks: [] },
    targets: [
      {
        kind: "coding-agent",
        adapter: extensionId("claude-code"),
        features: ["instructions", "skills", "subagents", "hooks", "mcp"],
        settings: {}
      },
      {
        kind: "coding-agent",
        adapter: extensionId("codex"),
        features: ["instructions", "skills", "subagents", "headless"],
        settings: {}
      },
      { kind: "chat-plugin", adapter: extensionId("chatgpt"), settings: {} },
      {
        kind: "coding-agent",
        adapter: extensionId("grok-build"),
        features: ["instructions", "skills", "hooks", "mcp"],
        settings: {}
      },
      {
        kind: "api-provider",
        adapter: extensionId("xai-api"),
        protocol: "responses",
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: extensionId("openrouter"),
        routing: {
          kind: "capability",
          requiredParameters: ["tools", "structured_outputs"],
          providerOrder: ["openai", "anthropic", "xai"]
        },
        settings: {}
      }
    ],
    packs: [extensionId("engineering")],
    generation: {
      sourceDirectory: ".aiyoke/source",
      lockFile: ".aiyoke/lock.json",
      lineEndings: "lf"
    }
  };
}
