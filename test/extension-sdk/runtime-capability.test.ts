import { describe, expect, it } from "vitest";
import {
  RUNTIME_CAPABILITY_FAMILY_IDS,
  type RuntimeCapabilityManifest,
  validateRuntimeCapabilityManifest
} from "../../src/extension-sdk/index.js";

const executed = new Set(["runtime.test.ts"]);

function validManifest(): RuntimeCapabilityManifest {
  return {
    schemaVersion: 1,
    language: "typescript",
    families: RUNTIME_CAPABILITY_FAMILY_IDS.map((id) => ({
      id,
      components: [
        {
          kind: "implemented",
          behaviors: ["executable-behavior"],
          acceptanceArtifacts: ["runtime.test.ts"]
        },
        {
          kind: "integration-port",
          contract: "ExamplePort",
          templateArtifacts: ["runtime.ts"],
          acceptanceArtifacts: ["runtime.test.ts"]
        }
      ]
    }))
  };
}

function replaceFirstFamily(manifest: RuntimeCapabilityManifest, family: unknown): unknown {
  return { ...manifest, families: [family, ...manifest.families.slice(1)] };
}

describe("runtime capability manifest validation", () => {
  it("accepts the exact composed seven-family contract", () => {
    const result = validateRuntimeCapabilityManifest(validManifest(), {
      language: "typescript",
      executedAcceptanceArtifacts: executed
    });
    expect(result.families.map(({ id }) => id)).toEqual(RUNTIME_CAPABILITY_FAMILY_IDS);
    expect(result.families.every(({ components }) => components.length === 2)).toBe(true);
  });

  it.each([
    ["non-object input", null],
    ["unknown schema", { ...validManifest(), schemaVersion: 2 }],
    ["wrong language", { ...validManifest(), language: "python" }],
    ["missing family", { ...validManifest(), families: validManifest().families.slice(0, -1) }],
    [
      "reordered families",
      { ...validManifest(), families: [...validManifest().families].reverse() }
    ]
  ])("rejects %s", (_label, manifest) => {
    expect(() =>
      validateRuntimeCapabilityManifest(manifest, {
        language: "typescript",
        executedAcceptanceArtifacts: executed
      })
    ).toThrow();
  });

  it("rejects missing, duplicated, or reversed delivery variants", () => {
    const manifest = validManifest();
    const first = manifest.families[0];
    if (first === undefined) throw new Error("fixture family missing");
    expect(() =>
      validateRuntimeCapabilityManifest(
        replaceFirstFamily(manifest, { ...first, components: [first.components[0]] }),
        { language: "typescript", executedAcceptanceArtifacts: executed }
      )
    ).toThrow();
    expect(() =>
      validateRuntimeCapabilityManifest(
        replaceFirstFamily(manifest, {
          ...first,
          components: [first.components[1], first.components[0]]
        }),
        { language: "typescript", executedAcceptanceArtifacts: executed }
      )
    ).toThrow();
    expect(() =>
      validateRuntimeCapabilityManifest(
        replaceFirstFamily(manifest, {
          ...first,
          components: [
            { ...first.components[0], behaviors: ["duplicate", "duplicate"] },
            first.components[1]
          ]
        }),
        { language: "typescript", executedAcceptanceArtifacts: executed }
      )
    ).toThrow();
  });

  it.each(["../escape.ts", "C:/escape.ts", "nested\\runtime.ts", "./runtime.ts"])(
    "rejects unsafe or noncanonical template path %s",
    (templatePath) => {
      const manifest = validManifest();
      const first = manifest.families[0];
      if (first === undefined) throw new Error("fixture family missing");
      expect(() =>
        validateRuntimeCapabilityManifest(
          replaceFirstFamily(manifest, {
            ...first,
            components: [
              first.components[0],
              { ...first.components[1], templateArtifacts: [templatePath] }
            ]
          }),
          { language: "typescript", executedAcceptanceArtifacts: executed }
        )
      ).toThrow();
    }
  );

  it("rejects acceptance artifacts that the native job does not execute", () => {
    const manifest = validManifest();
    const first = manifest.families[0];
    if (first === undefined) throw new Error("fixture family missing");
    expect(() =>
      validateRuntimeCapabilityManifest(
        replaceFirstFamily(manifest, {
          ...first,
          components: [
            { ...first.components[0], acceptanceArtifacts: ["unexecuted.test.ts"] },
            first.components[1]
          ]
        }),
        { language: "typescript", executedAcceptanceArtifacts: executed }
      )
    ).toThrow(/not executed/);
  });
});
