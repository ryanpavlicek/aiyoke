import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  defaultHarnessSpec,
  parseHarnessSpec,
  stringifyHarnessSpec
} from "../../src/infrastructure/config/index.js";

describe("YAML configuration", () => {
  it("round-trips the default rich target model", () => {
    const spec = defaultHarnessSpec("example");
    expect(parseHarnessSpec(stringifyHarnessSpec(spec))).toEqual(spec);
    expect(spec.targets.map((target) => target.adapter)).toEqual([
      "claude-code",
      "codex",
      "chatgpt",
      "grok-build",
      "xai-api",
      "openrouter"
    ]);
  });

  it("rejects unsupported language ids before extension resolution", () => {
    const source = stringifyHarnessSpec(defaultHarnessSpec("example")).replace(
      "- typescript",
      "- TypeScript"
    );
    expect(() => parseHarnessSpec(source)).toThrow(/extension id/i);
  });

  it("rejects malformed YAML and non-object roots", () => {
    expect(() => parseHarnessSpec("[unterminated")).toThrow(/valid YAML/);
    expect(() => parseHarnessSpec("[]")).toThrow(/must be an object/);
  });

  it("rejects invalid top-level and generation variants", () => {
    const invalidSources = [
      stringify({ ...defaultHarnessSpec("example"), schemaVersion: 2 }),
      stringify({
        ...defaultHarnessSpec("example"),
        project: { name: "example", architecture: "unknown" }
      }),
      stringify({ ...defaultHarnessSpec("example"), targets: {} }),
      stringify({
        ...defaultHarnessSpec("example"),
        generation: {
          sourceDirectory: ".aiyoke/source",
          lockFile: ".aiyoke/lock.json",
          lineEndings: "crlf"
        }
      }),
      stringify({
        ...defaultHarnessSpec("example"),
        generation: {
          sourceDirectory: "../outside",
          lockFile: ".aiyoke/lock.json",
          lineEndings: "lf"
        }
      }),
      stringify({
        ...defaultHarnessSpec("example"),
        stack: { languages: ["python", "python"], frameworks: [] }
      })
    ];
    for (const source of invalidSources) expect(() => parseHarnessSpec(source)).toThrow();
  });

  it("rejects invalid target variants and routing policies", () => {
    const base = defaultHarnessSpec("example");
    const invalidTargets: readonly unknown[] = [
      { kind: "coding-agent", adapter: "codex", features: ["telepathy"], settings: {} },
      { kind: "api-provider", adapter: "xai-api", protocol: "legacy", settings: {} },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: { kind: "fixed", model: "" },
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: { kind: "fallback", models: [] },
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: { kind: "capability", requiredParameters: 1, providerOrder: [] },
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: { kind: "random" },
        settings: {}
      },
      { kind: "unsupported", adapter: "codex", settings: {} },
      { kind: "chat-plugin", adapter: "chatgpt", settings: { value: Number.POSITIVE_INFINITY } },
      {
        kind: "chat-plugin",
        adapter: "chatgpt",
        settings: JSON.parse('{"__proto__":"unsafe"}') as unknown
      }
    ];
    for (const target of invalidTargets) {
      expect(() => parseHarnessSpec(stringify({ ...base, targets: [target] }))).toThrow();
    }
  });

  it("rejects duplicate target identities", () => {
    const base = defaultHarnessSpec("example");
    const target = base.targets[0];
    expect(target).toBeDefined();
    expect(() => parseHarnessSpec(stringify({ ...base, targets: [target, target] }))).toThrow(
      /duplicate/
    );
  });
});
