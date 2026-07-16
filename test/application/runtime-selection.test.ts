import { describe, expect, it } from "vitest";
import { runtimeTemplateReferences } from "../../src/application/index.js";
import { extensionId } from "../../src/core/index.js";
import { type ExtensionLoader, ExtensionRegistry } from "../../src/extension-sdk/index.js";
import { typescriptRuntimeLoader } from "../../src/extensions/runtimes/index.js";

describe("runtime template selection", () => {
  it("selects one registered runtime per language deterministically", () => {
    const registry = new ExtensionRegistry().registerRuntime(typescriptRuntimeLoader);
    expect(
      runtimeTemplateReferences(registry, [extensionId("typescript"), extensionId("typescript")])
    ).toEqual([{ kind: "runtime", id: "typescript-runtime" }]);
    expect(() => runtimeTemplateReferences(registry, [extensionId("python")])).toThrow(
      /not registered/
    );
  });

  it("rejects duplicate language ownership through typed and generic registration", () => {
    const duplicate = {
      ...typescriptRuntimeLoader,
      descriptor: {
        ...typescriptRuntimeLoader.descriptor,
        id: extensionId("alternative-typescript-runtime")
      }
    } as ExtensionLoader;
    expect(() =>
      new ExtensionRegistry().registerRuntime(typescriptRuntimeLoader).registerRuntime(duplicate)
    ).toThrow(/already owned/);

    const bypassed = new ExtensionRegistry().register(typescriptRuntimeLoader).register(duplicate);
    expect(() => runtimeTemplateReferences(bypassed, [extensionId("typescript")])).toThrow(
      /Multiple runtime templates/
    );
  });
});
