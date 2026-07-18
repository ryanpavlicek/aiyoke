import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { AiyokeError, PRODUCTION_RUNTIME_POLICY } from "../../src/core/index.js";
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

  it("aggregates direct validation failures with source positions", () => {
    const source = `schemaVersion: 3
unexpected: true
project:
  name: ""
  architecture: sideways
  extra: true
composition:
  kind: single
  stack:
    languages: []
    frameworks: []
runtime:
  kind: disabled
targets: wrong
packs: wrong
generation:
  sourceDirectory: ""
  lockFile: ""
  lineEndings: mixed
  extra: true
`;

    try {
      parseHarnessSpec(source);
      throw new Error("Expected invalid configuration to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiyokeError);
      const aiyokeError = error as AiyokeError;
      expect(aiyokeError.message).toMatch(/10 validation issue/);
      const issues = aiyokeError.details.issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "unexpected", line: 2, column: 13 }),
          expect.objectContaining({ path: "project.name", line: 4 }),
          expect.objectContaining({ path: "project.architecture", line: 5 }),
          expect.objectContaining({ path: "targets", line: 14 }),
          expect.objectContaining({ path: "generation.lineEndings", line: 19 })
        ])
      );
    }
  });

  it("reports the source position for YAML syntax failures", () => {
    try {
      parseHarnessSpec("schemaVersion: 3\nproject: [unterminated\n");
      throw new Error("Expected malformed YAML to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiyokeError);
      const issues = (error as AiyokeError).details.issues;
      expect(issues).toEqual([
        expect.objectContaining({ path: "aiyoke.yaml", line: 3, column: expect.any(Number) })
      ]);
    }
  });

  it("aggregates independent semantic failures across configuration branches", () => {
    const base = defaultHarnessSpec("semantic-errors");
    const source = stringify({
      ...base,
      composition: { kind: "unknown" },
      runtime: { kind: "unknown" },
      targets: [
        { kind: "unsupported", adapter: "codex", settings: {} },
        { kind: "chat-plugin", adapter: "chatgpt", settings: [] }
      ],
      packs: ["Bad"],
      generation: {
        sourceDirectory: "../source",
        lockFile: "../lock.json",
        lineEndings: "lf"
      }
    });

    try {
      parseHarnessSpec(source);
      throw new Error("Expected semantic failures to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiyokeError);
      const aiyokeError = error as AiyokeError;
      expect(aiyokeError.message).toMatch(/7 validation issue/);
      expect(aiyokeError.details.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "composition.kind", line: expect.any(Number) }),
          expect.objectContaining({ path: "runtime.kind", line: expect.any(Number) }),
          expect.objectContaining({ path: "targets[0].kind", line: expect.any(Number) }),
          expect.objectContaining({ path: "targets[1].settings", line: expect.any(Number) }),
          expect.objectContaining({ path: "packs", line: expect.any(Number) }),
          expect.objectContaining({
            path: "generation.sourceDirectory",
            line: expect.any(Number)
          }),
          expect.objectContaining({ path: "generation.lockFile", line: expect.any(Number) })
        ])
      );
    }
  });

  it("rejects invalid top-level and generation variants", () => {
    const invalidSources = [
      stringify({ ...defaultHarnessSpec("example"), schemaVersion: 4 }),
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
          lineEndings: "native"
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
        composition: {
          kind: "single",
          stack: { languages: ["python", "python"], frameworks: [] }
        }
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
    expect(() =>
      parseHarnessSpec(stringify({ ...base, targets: [target, structuredClone(target)] }))
    ).toThrow(/duplicate/);
  });

  it("round-trips a custom production runtime policy", () => {
    const spec = defaultHarnessSpec("runtime");
    const custom = {
      ...spec,
      runtime: {
        kind: "enabled" as const,
        outputDirectory: "generated/ai",
        profile: { kind: "custom" as const, ...structuredClone(PRODUCTION_RUNTIME_POLICY) }
      }
    };
    expect(parseHarnessSpec(stringifyHarnessSpec(custom))).toEqual(custom);
  });

  it("round-trips the supported CRLF generation policy", () => {
    const spec = defaultHarnessSpec("windows");
    const configured = {
      ...spec,
      generation: { ...spec.generation, lineEndings: "crlf" as const }
    };
    expect(parseHarnessSpec(stringifyHarnessSpec(configured))).toEqual(configured);
  });

  it("rejects unsafe or out-of-range runtime policies", () => {
    const base = defaultHarnessSpec("runtime");
    const policy = structuredClone(PRODUCTION_RUNTIME_POLICY);
    const cases = [
      { kind: "enabled", outputDirectory: "../outside", profile: { kind: "production" } },
      { kind: "disabled", unknown: true },
      {
        kind: "enabled",
        outputDirectory: "runtime",
        profile: {
          kind: "custom",
          ...policy,
          reliability: {
            ...policy.reliability,
            retry: { ...policy.reliability.retry, maxAttempts: 0 }
          }
        }
      },
      {
        kind: "enabled",
        outputDirectory: "runtime",
        profile: {
          kind: "custom",
          ...policy,
          evaluation: { kind: "sampled-online", sampleRate: 2 }
        }
      },
      {
        kind: "enabled",
        outputDirectory: "runtime",
        profile: {
          kind: "custom",
          ...policy,
          performance: { ...policy.performance, maxConcurrency: 0 }
        }
      }
    ];
    for (const runtime of cases) {
      expect(() => parseHarnessSpec(stringify({ ...base, runtime }))).toThrow();
    }
  });
});
