import { parse, stringify } from "yaml";
import type { SchemaDocument } from "../../application/index.js";
import {
  type AgentFeature,
  AiyokeError,
  extensionId,
  type HarnessSpec,
  type HarnessStack,
  type JsonObject,
  type JsonValue,
  type ProjectComposition,
  safeRelativePath,
  type TargetSpec
} from "../../core/index.js";

export const CURRENT_SCHEMA_VERSION = 2;

const AGENT_FEATURES = new Set<AgentFeature>([
  "instructions",
  "skills",
  "subagents",
  "hooks",
  "mcp",
  "permissions",
  "headless"
]);

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;

interface JsonValidationState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length > 0) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `${label} contains unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.sort().join(", ")}.`
    );
  }
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

function uniqueNonEmptyStringArray(value: unknown, label: string): readonly string[] {
  const items = stringArray(value, label);
  if (items.some((item) => item.trim().length === 0)) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain blank values.`);
  }
  if (new Set(items).size !== items.length) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain duplicates.`);
  }
  return items;
}

function idArray(value: unknown, label: string) {
  const ids = stringArray(value, label).map(extensionId);
  if (new Set(ids).size !== ids.length) {
    throw new AiyokeError("INVALID_SPEC", `${label} cannot contain duplicates.`);
  }
  return ids;
}

function isJsonValue(
  value: unknown,
  state: JsonValidationState = { ancestors: new WeakSet<object>(), nodes: 0 },
  depth = 0
): value is JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (state.ancestors.has(value)) return false;
  state.ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, state, depth + 1))
    : Object.entries(value).every(
        ([key, item]) =>
          key !== "__proto__" &&
          key !== "prototype" &&
          key !== "constructor" &&
          isJsonValue(item, state, depth + 1)
      );
  state.ancestors.delete(value);
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

function stackSpec(value: unknown, label: string): HarnessStack {
  const stack = record(value, label);
  allowedKeys(stack, ["languages", "frameworks"], label);
  return {
    languages: idArray(stack.languages ?? [], `${label}.languages`),
    frameworks: idArray(stack.frameworks ?? [], `${label}.frameworks`)
  };
}

function compositionSpec(value: unknown): ProjectComposition {
  const composition = record(value, "composition");
  if (composition.kind === "single") {
    allowedKeys(composition, ["kind", "stack"], "composition");
    return { kind: "single", stack: stackSpec(composition.stack, "composition.stack") };
  }
  if (composition.kind === "monorepo") {
    allowedKeys(composition, ["kind", "root", "workspaces"], "composition");
    if (!Array.isArray(composition.workspaces) || composition.workspaces.length === 0) {
      throw new AiyokeError(
        "INVALID_SPEC",
        "composition.workspaces must be a non-empty array for a monorepo."
      );
    }
    const workspaces = composition.workspaces.map((value, index) => {
      const label = `composition.workspaces[${index}]`;
      const workspace = record(value, label);
      allowedKeys(workspace, ["id", "path", "stack"], label);
      return {
        id: extensionId(requiredString(workspace.id, `${label}.id`)),
        path: safeRelativePath(requiredString(workspace.path, `${label}.path`)),
        stack: stackSpec(workspace.stack, `${label}.stack`)
      };
    });
    if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) {
      throw new AiyokeError("INVALID_SPEC", "Monorepo workspace ids cannot contain duplicates.");
    }
    if (new Set(workspaces.map((workspace) => workspace.path)).size !== workspaces.length) {
      throw new AiyokeError("INVALID_SPEC", "Monorepo workspace paths cannot contain duplicates.");
    }
    return { kind: "monorepo", root: stackSpec(composition.root, "composition.root"), workspaces };
  }
  throw new AiyokeError("INVALID_SPEC", "composition.kind must be single or monorepo.");
}

function targetSpec(value: unknown, index: number): TargetSpec {
  const target = record(value, `targets[${index}]`);
  const kind = requiredString(target.kind, `targets[${index}].kind`);
  const adapter = extensionId(requiredString(target.adapter, `targets[${index}].adapter`));
  const targetSettings = settings(target.settings, `targets[${index}].settings`);

  if (kind === "coding-agent") {
    allowedKeys(target, ["kind", "adapter", "features", "settings"], `targets[${index}]`);
    const features = uniqueNonEmptyStringArray(target.features ?? [], `targets[${index}].features`);
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
  if (kind === "chat-plugin") {
    allowedKeys(target, ["kind", "adapter", "settings"], `targets[${index}]`);
    return { kind, adapter, settings: targetSettings };
  }
  if (kind === "api-provider") {
    allowedKeys(target, ["kind", "adapter", "protocol", "settings"], `targets[${index}]`);
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
    allowedKeys(target, ["kind", "adapter", "routing", "settings"], `targets[${index}]`);
    const routing = record(target.routing, `targets[${index}].routing`);
    const routeKind = routing.kind;
    if (routeKind === "fixed") {
      allowedKeys(routing, ["kind", "model"], `targets[${index}].routing`);
      return {
        kind,
        adapter,
        routing: { kind: routeKind, model: requiredString(routing.model, "routing.model") },
        settings: targetSettings
      };
    }
    if (routeKind === "fallback") {
      allowedKeys(routing, ["kind", "models"], `targets[${index}].routing`);
      const models = uniqueNonEmptyStringArray(routing.models, "routing.models");
      if (models.length === 0) {
        throw new AiyokeError("INVALID_SPEC", "routing.models cannot be empty.");
      }
      return { kind, adapter, routing: { kind: routeKind, models }, settings: targetSettings };
    }
    if (routeKind === "capability") {
      allowedKeys(
        routing,
        ["kind", "requiredParameters", "providerOrder"],
        `targets[${index}].routing`
      );
      return {
        kind,
        adapter,
        routing: {
          kind: routeKind,
          requiredParameters: uniqueNonEmptyStringArray(
            routing.requiredParameters ?? [],
            "routing.requiredParameters"
          ),
          providerOrder: uniqueNonEmptyStringArray(
            routing.providerOrder ?? [],
            "routing.providerOrder"
          )
        },
        settings: targetSettings
      };
    }
    throw new AiyokeError("INVALID_SPEC", `targets[${index}].routing.kind is invalid.`);
  }
  throw new AiyokeError("INVALID_SPEC", `targets[${index}].kind is not supported.`);
}

function parseYaml(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `aiyoke.yaml exceeds the ${MAX_CONFIG_BYTES}-byte limit.`
    );
  }
  let value: unknown;
  try {
    value = parse(source, {
      maxAliasCount: 0,
      merge: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2"
    });
  } catch (error) {
    throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml is not valid YAML.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  return value;
}

export function parseSchemaDocument(source: string): SchemaDocument {
  const root = record(parseYaml(source), "aiyoke.yaml");
  if (!isJsonValue(root)) {
    throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml exceeds JSON safety limits.");
  }
  if (!Number.isSafeInteger(root.schemaVersion) || (root.schemaVersion as number) < 1) {
    throw new AiyokeError("INVALID_SPEC", "schemaVersion must be a positive safe integer.");
  }
  return root as SchemaDocument;
}

export function parseHarnessSpec(source: string): HarnessSpec {
  const root = parseSchemaDocument(source);
  if (root.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `schemaVersion must be ${CURRENT_SCHEMA_VERSION}; run \`aiyoke migrate\` for older configurations.`
    );
  }
  allowedKeys(
    root,
    ["schemaVersion", "project", "composition", "targets", "packs", "generation"],
    "aiyoke.yaml"
  );
  const project = record(root.project, "project");
  allowedKeys(project, ["name", "architecture"], "project");
  const architecture = project.architecture;
  if (
    architecture !== "layered" &&
    architecture !== "hexagonal" &&
    architecture !== "clean" &&
    architecture !== "custom"
  ) {
    throw new AiyokeError("INVALID_SPEC", "project.architecture is invalid.");
  }
  const generation = record(root.generation, "generation");
  allowedKeys(generation, ["sourceDirectory", "lockFile", "lineEndings"], "generation");
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      name: requiredString(project.name, "project.name"),
      architecture
    },
    composition: compositionSpec(root.composition),
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

export function stringifySchemaDocument(document: SchemaDocument): string {
  return stringify(document, { lineWidth: 0 });
}

export function defaultHarnessSpec(projectName: string): HarnessSpec {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: { name: projectName, architecture: "layered" },
    composition: {
      kind: "single",
      stack: { languages: [extensionId("typescript")], frameworks: [] }
    },
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
