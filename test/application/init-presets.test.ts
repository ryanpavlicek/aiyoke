import { describe, expect, it } from "vitest";
import {
  createDefaultInitPresetRegistry,
  type InitPreset,
  InitPresetRegistry
} from "../../src/application/index.js";
import { extensionId } from "../../src/core/index.js";
import { defaultHarnessSpec } from "../../src/infrastructure/config/index.js";

describe("initialization preset registry", () => {
  it("registers the simple preset and returns deterministic target selections", () => {
    const registry = createDefaultInitPresetRegistry();
    expect(registry.list().map((preset) => preset.id)).toEqual(["simple"]);
    expect(registry.has(extensionId("simple"))).toBe(true);
    expect(registry.has(extensionId("missing"))).toBe(false);
    expect(
      registry.get(extensionId("simple")).select({
        defaults: defaultHarnessSpec("simple"),
        detectedLanguages: [extensionId("typescript")],
        detectedFrameworks: [extensionId("nextjs")]
      })
    ).toEqual({
      targetAdapters: [extensionId("claude-code"), extensionId("openrouter")]
    });
  });

  it("supports additive registration, sorted listing, duplicate rejection, and freezing", () => {
    const custom: InitPreset = {
      id: extensionId("z-custom"),
      displayName: "Z Custom",
      description: "A test preset.",
      select: () => ({ targetAdapters: [extensionId("openrouter")] })
    };
    const registry = new InitPresetRegistry().register(custom).register({
      id: extensionId("a-custom"),
      displayName: "A Custom",
      description: "Another test preset.",
      select: () => ({})
    });

    expect(registry.list().map((preset) => preset.id)).toEqual(["a-custom", "z-custom"]);
    expect(() => registry.register(custom)).toThrow(/already registered/);
    registry.freeze();
    expect(registry.frozen).toBe(true);
    expect(() => registry.register(custom)).toThrow(/frozen/);
    expect(() => registry.get(extensionId("missing"))).toThrow(/Unknown initialization preset/);
  });

  it("does not allow duplicate built-in and additional preset ids", () => {
    expect(() =>
      createDefaultInitPresetRegistry([
        {
          id: extensionId("simple"),
          displayName: "Duplicate simple",
          description: "A duplicate built-in id.",
          select: () => ({})
        }
      ])
    ).toThrow(/already registered/);
  });

  it("rejects empty metadata and reports unknown ids on an empty registry", () => {
    expect(() =>
      new InitPresetRegistry().register({
        id: extensionId("invalid"),
        displayName: " ",
        description: "missing display name",
        select: () => ({})
      })
    ).toThrow(/display name and description/);
    expect(() => new InitPresetRegistry().get(extensionId("missing"))).toThrow(
      "Unknown initialization preset missing."
    );
  });
});
