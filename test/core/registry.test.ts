import { describe, expect, it, vi } from "vitest";
import { extensionId } from "../../src/core/index.js";
import {
  type CapabilityPackExtension,
  EXTENSION_API_VERSION,
  type ExtensionLoader,
  ExtensionRegistry
} from "../../src/extension-sdk/index.js";

function packLoader(
  id: string,
  requires: readonly { readonly kind: "pack"; readonly id: ReturnType<typeof extensionId> }[] = [],
  conflicts: readonly { readonly kind: "pack"; readonly id: ReturnType<typeof extensionId> }[] = []
): ExtensionLoader<CapabilityPackExtension> {
  const descriptor = {
    kind: "pack" as const,
    id: extensionId(id),
    version: "1.0.0",
    apiVersion: EXTENSION_API_VERSION as typeof EXTENSION_API_VERSION,
    displayName: id,
    description: id,
    capabilities: [],
    requires,
    conflicts
  };
  return {
    descriptor,
    load: vi.fn(async () => ({
      descriptor,
      async contribute() {
        return {
          id,
          title: id,
          source: id,
          instructions: [],
          skills: [],
          hooks: [],
          mcpServers: [],
          subagents: []
        };
      }
    }))
  };
}

describe("ExtensionRegistry", () => {
  it("loads registered extensions lazily and caches them", async () => {
    const loader = packLoader("engineering");
    const registry = new ExtensionRegistry().registerPack(loader).freeze();
    expect(loader.load).not.toHaveBeenCalled();
    await registry.get({ kind: "pack", id: extensionId("engineering") });
    await registry.get({ kind: "pack", id: extensionId("engineering") });
    expect(loader.load).toHaveBeenCalledTimes(1);
  });

  it("resolves requirements before dependents", async () => {
    const base = packLoader("base");
    const feature = packLoader("feature", [{ kind: "pack", id: extensionId("base") }]);
    const registry = new ExtensionRegistry().registerPack(feature).registerPack(base).freeze();
    const resolved = await registry.resolve([{ kind: "pack", id: extensionId("feature") }]);
    expect(resolved.map((extension) => extension.descriptor.id)).toEqual(["base", "feature"]);
  });

  it("rejects duplicate registration", () => {
    const registry = new ExtensionRegistry().registerPack(packLoader("base"));
    expect(() => registry.registerPack(packLoader("base"))).toThrow(/already registered/);
  });

  it("rejects invalid registration lifecycle and API metadata", () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.registerTarget(packLoader("wrong-kind"))).toThrow(/Expected a target/);

    const incompatible = {
      ...packLoader("incompatible"),
      descriptor: { ...packLoader("incompatible").descriptor, apiVersion: "0.0.0" }
    } as unknown as ExtensionLoader;
    expect(() => registry.register(incompatible)).toThrow(/expected 1.0.0/);

    registry.registerPack(packLoader("base")).freeze();
    expect(registry.frozen).toBe(true);
    expect(() => registry.registerPack(packLoader("later"))).toThrow(/frozen/);
  });

  it("rejects missing requirements and dependency cycles when frozen", () => {
    const missing = new ExtensionRegistry().registerPack(
      packLoader("feature", [{ kind: "pack", id: extensionId("missing") }])
    );
    expect(() => missing.freeze()).toThrow(/not registered/);

    const cyclic = new ExtensionRegistry()
      .registerPack(packLoader("a", [{ kind: "pack", id: extensionId("b") }]))
      .registerPack(packLoader("b", [{ kind: "pack", id: extensionId("a") }]));
    expect(() => cyclic.freeze()).toThrow(/cycle/);
  });

  it("rejects selected conflicts before loading", async () => {
    const registry = new ExtensionRegistry()
      .registerPack(packLoader("a", [], [{ kind: "pack", id: extensionId("b") }]))
      .registerPack(packLoader("b"))
      .freeze();
    await expect(
      registry.resolve([
        { kind: "pack", id: extensionId("a") },
        { kind: "pack", id: extensionId("b") }
      ])
    ).rejects.toThrow(/conflicts/);
  });

  it("reports missing lookups and loader identity mismatches", async () => {
    const empty = new ExtensionRegistry().freeze();
    await expect(empty.get({ kind: "pack", id: extensionId("missing") })).rejects.toThrow(
      /not registered/
    );

    const declared = packLoader("declared");
    const returned = packLoader("returned");
    const registry = new ExtensionRegistry()
      .registerPack({ descriptor: declared.descriptor, load: returned.load })
      .freeze();
    await expect(registry.get({ kind: "pack", id: extensionId("declared") })).rejects.toThrow(
      /different descriptor.*pack:returned/
    );

    const changedMetadata = packLoader("same-id");
    const metadataRegistry = new ExtensionRegistry()
      .registerPack({
        descriptor: changedMetadata.descriptor,
        async load() {
          const loaded = await changedMetadata.load();
          return {
            ...loaded,
            descriptor: { ...loaded.descriptor, description: "Changed after registration." }
          };
        }
      })
      .freeze();
    await expect(
      metadataRegistry.get({ kind: "pack", id: extensionId("same-id") })
    ).rejects.toThrow(/different descriptor/);
  });

  it("lists and filters deterministic registry metadata", () => {
    const registry = new ExtensionRegistry()
      .registerPack(packLoader("zeta"))
      .registerPack(packLoader("alpha"));
    const reference = registry.reference("pack", extensionId("alpha"));
    expect(registry.has(reference)).toBe(true);
    expect(registry.list("pack").map((loader) => loader.descriptor.id)).toEqual(["alpha", "zeta"]);
    expect(registry.list("target")).toEqual([]);
  });
});
