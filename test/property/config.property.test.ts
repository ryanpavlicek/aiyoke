import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  extensionId,
  type HarnessSpec,
  type JsonObject,
  safeRelativePath,
  type TargetSpec
} from "../../src/core/index.js";
import { parseHarnessSpec, stringifyHarnessSpec } from "../../src/infrastructure/config/index.js";

const RUNS = 200;
const extensionIdArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9]{0,8}(?:-[a-z0-9]{1,8}){0,2}$/)
  .map(extensionId);
const nonBlankString = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ./_:@+-]{0,40}$/);
const settingsArbitrary = fc
  .dictionary(
    fc.stringMatching(/^[a-z][a-zA-Z0-9_-]{0,12}$/),
    fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()), {
        maxLength: 5
      })
    ),
    { maxKeys: 5 }
  )
  .map((value) => value as JsonObject);

const codingAgentArbitrary = fc
  .record({
    adapter: extensionIdArbitrary,
    features: fc.uniqueArray(
      fc.constantFrom(
        "instructions" as const,
        "skills" as const,
        "subagents" as const,
        "hooks" as const,
        "mcp" as const,
        "permissions" as const,
        "headless" as const
      ),
      { maxLength: 7 }
    ),
    settings: settingsArbitrary
  })
  .map(
    ({ adapter, features, settings }): TargetSpec => ({
      kind: "coding-agent",
      adapter,
      features,
      settings
    })
  );

const chatPluginArbitrary = fc
  .record({ adapter: extensionIdArbitrary, settings: settingsArbitrary })
  .map(({ adapter, settings }): TargetSpec => ({ kind: "chat-plugin", adapter, settings }));

const apiProviderArbitrary = fc
  .record({
    adapter: extensionIdArbitrary,
    protocol: fc.constantFrom("responses" as const, "chat-completions" as const),
    settings: settingsArbitrary
  })
  .map(
    ({ adapter, protocol, settings }): TargetSpec => ({
      kind: "api-provider",
      adapter,
      protocol,
      settings
    })
  );

const routeArbitrary = fc.oneof(
  nonBlankString.map((model) => ({ kind: "fixed" as const, model })),
  fc
    .uniqueArray(nonBlankString, { minLength: 1, maxLength: 5 })
    .map((models) => ({ kind: "fallback" as const, models })),
  fc
    .record({
      requiredParameters: fc.uniqueArray(nonBlankString, { maxLength: 5 }),
      providerOrder: fc.uniqueArray(nonBlankString, { maxLength: 5 })
    })
    .map(({ requiredParameters, providerOrder }) => ({
      kind: "capability" as const,
      requiredParameters,
      providerOrder
    }))
);

const gatewayArbitrary = fc
  .record({ adapter: extensionIdArbitrary, routing: routeArbitrary, settings: settingsArbitrary })
  .map(
    ({ adapter, routing, settings }): TargetSpec => ({
      kind: "inference-gateway",
      adapter,
      routing,
      settings
    })
  );

const targetArbitrary = fc.oneof(
  codingAgentArbitrary,
  chatPluginArbitrary,
  apiProviderArbitrary,
  gatewayArbitrary
);

const stackArbitrary = fc.record({
  languages: fc.uniqueArray(extensionIdArbitrary, { maxLength: 5 }),
  frameworks: fc.uniqueArray(extensionIdArbitrary, { maxLength: 5 })
});

const compositionArbitrary = fc.oneof(
  stackArbitrary.map((stack) => ({ kind: "single" as const, stack })),
  fc
    .record({
      root: stackArbitrary,
      workspaces: fc.uniqueArray(fc.record({ id: extensionIdArbitrary, stack: stackArbitrary }), {
        minLength: 1,
        maxLength: 8,
        selector: (workspace) => workspace.id
      })
    })
    .map(({ root, workspaces }) => ({
      kind: "monorepo" as const,
      root,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        path: `packages/${workspace.id}`
      }))
    }))
);

const specArbitrary = fc
  .record({
    name: nonBlankString,
    architecture: fc.constantFrom(
      "layered" as const,
      "hexagonal" as const,
      "clean" as const,
      "custom" as const
    ),
    composition: compositionArbitrary,
    targets: fc.uniqueArray(targetArbitrary, {
      maxLength: 8,
      selector: (target) => `${target.kind}:${target.adapter}`
    }),
    packs: fc.uniqueArray(extensionIdArbitrary, { maxLength: 5 })
  })
  .map(
    ({ name, architecture, composition, targets, packs }): HarnessSpec => ({
      schemaVersion: 3,
      project: { name, architecture },
      composition,
      runtime: {
        kind: "enabled",
        outputDirectory: "aiyoke-runtime",
        profile: { kind: "production" }
      },
      targets,
      packs,
      generation: {
        sourceDirectory: ".aiyoke/source",
        lockFile: ".aiyoke/lock.json",
        lineEndings: "lf"
      }
    })
  );

describe("configuration properties", () => {
  it("round-trips valid discriminated specifications deterministically", () => {
    fc.assert(
      fc.property(specArbitrary, (spec) => {
        const first = stringifyHarnessSpec(spec);
        const parsed = parseHarnessSpec(first);
        expect(parsed).toEqual(spec);
        expect(stringifyHarnessSpec(parsed)).toBe(first);
      }),
      { numRuns: RUNS }
    );
  });

  it("normalizes safe platform-independent paths", () => {
    const component = fc
      .stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,20}$/)
      .filter(
        (value) =>
          !value.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)
      );
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (parts, win) => {
          const separator = win ? "\\" : "/";
          expect(safeRelativePath(parts.join(separator))).toBe(parts.join("/"));
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("preserves safe Unicode path components across separators", () => {
    const component = fc
      .array(fc.constantFrom("é", "漢", "λ", "д", "ñ", "ø", "१"), {
        minLength: 1,
        maxLength: 12
      })
      .map((characters) => characters.join(""));
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (parts, windows) => {
          const separator = windows ? "\\" : "/";
          expect(safeRelativePath(parts.join(separator))).toBe(parts.join("/"));
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects generated traversal, absolute, reserved, and malformed paths", () => {
    const unsafePath = fc.oneof(
      nonBlankString.map((tail) => `../${tail}`),
      nonBlankString.map((tail) => `safe/../${tail}`),
      nonBlankString.map((tail) => `/${tail}`),
      fc
        .tuple(fc.constantFrom("C", "D", "z"), nonBlankString)
        .map(([drive, tail]) => `${drive}:\\${tail}`),
      fc.constantFrom("CON", "aux.txt", "safe/NUL", "COM1.log", "LPT9", "trailing.", "space "),
      nonBlankString.map((tail) => `safe/${tail}\0bad`),
      fc
        .tuple(nonBlankString, fc.constantFrom("<", ">", ":", '"', "|", "?", "*"))
        .map(([head, invalid]) => `${head}${invalid}bad`)
    );
    fc.assert(
      fc.property(unsafePath, (path) => {
        expect(() => safeRelativePath(path)).toThrow();
      }),
      { numRuns: RUNS }
    );
  });
});
