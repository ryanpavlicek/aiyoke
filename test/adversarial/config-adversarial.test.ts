import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { defaultHarnessSpec, parseHarnessSpec } from "../../src/infrastructure/config/index.js";

describe("adversarial YAML configuration", () => {
  it("rejects oversized input before parsing", () => {
    expect(() => parseHarnessSpec("#".repeat(1024 * 1024 + 1))).toThrow(/byte limit/);
  });

  it("rejects aliases and duplicate keys", () => {
    const alias = `schemaVersion: 1
project: &project
  name: example
  architecture: layered
stack: *project
targets: []
packs: []
generation:
  sourceDirectory: .aiyoke/source
  lockFile: .aiyoke/lock.json
  lineEndings: lf
`;
    expect(() => parseHarnessSpec(alias)).toThrow(/valid YAML/);

    const duplicate = stringify(defaultHarnessSpec("example")).replace(
      "schemaVersion: 2",
      "schemaVersion: 2\nschemaVersion: 2"
    );
    expect(() => parseHarnessSpec(duplicate)).toThrow(/valid YAML/);
  });

  it("rejects unknown fields at every structural boundary", () => {
    const base = defaultHarnessSpec("example");
    const cases = [
      { ...base, typo: true },
      { ...base, project: { ...base.project, typo: true } },
      { ...base, composition: { ...base.composition, typo: true } },
      { ...base, generation: { ...base.generation, typo: true } },
      {
        ...base,
        targets: [{ kind: "chat-plugin", adapter: "chatgpt", settings: {}, typo: true }]
      },
      {
        ...base,
        targets: [
          {
            kind: "inference-gateway",
            adapter: "openrouter",
            routing: { kind: "fixed", model: "example/model", typo: true },
            settings: {}
          }
        ]
      }
    ];
    for (const value of cases) expect(() => parseHarnessSpec(stringify(value))).toThrow(/unknown/);
  });

  it("bounds settings depth and total node count", () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    expect(() =>
      parseHarnessSpec(
        stringify({
          ...defaultHarnessSpec("example"),
          targets: [{ kind: "chat-plugin", adapter: "chatgpt", settings: nested }]
        })
      )
    ).toThrow(/JSON safety/);

    const manyValues = Array.from({ length: 10_001 }, (_, index) => index);
    expect(() =>
      parseHarnessSpec(
        stringify({
          ...defaultHarnessSpec("example"),
          targets: [{ kind: "chat-plugin", adapter: "chatgpt", settings: { manyValues } }]
        })
      )
    ).toThrow(/JSON safety/);
  });

  it("rejects ambiguous duplicate route and feature values", () => {
    const base = defaultHarnessSpec("example");
    const cases = [
      {
        kind: "coding-agent",
        adapter: "codex",
        features: ["skills", "skills"],
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: { kind: "fallback", models: ["one", "one"] },
        settings: {}
      },
      {
        kind: "inference-gateway",
        adapter: "openrouter",
        routing: {
          kind: "capability",
          requiredParameters: ["tools", "tools"],
          providerOrder: []
        },
        settings: {}
      }
    ];
    for (const target of cases) {
      expect(() => parseHarnessSpec(stringify({ ...base, targets: [target] }))).toThrow(
        /duplicate/
      );
    }
  });
});
