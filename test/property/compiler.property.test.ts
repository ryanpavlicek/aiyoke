import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HarnessCompiler, type HashPort, type WorkspacePort } from "../../src/application/index.js";
import {
  type ArtifactIntent,
  extensionId,
  type HarnessSpec,
  type JsonObject
} from "../../src/core/index.js";
import {
  EXTENSION_API_VERSION,
  ExtensionRegistry,
  type TargetExtension
} from "../../src/extension-sdk/index.js";

const START = "<!-- aiyoke:managed:start -->";
const END = "<!-- aiyoke:managed:end -->";
const RUNS = 150;

class MemoryWorkspace implements WorkspacePort {
  readonly root = "/workspace";
  readonly files: readonly string[] = [];
  readonly values = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.values.get(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.values.has(path);
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.values.set(path, content);
  }
}

const sha256: HashPort = {
  digest: (value) => createHash("sha256").update(value).digest("hex")
};

function spec(settings: JsonObject = {}): HarnessSpec {
  return {
    schemaVersion: 3,
    project: { name: "property-fixture", architecture: "layered" },
    composition: { kind: "single", stack: { languages: [], frameworks: [] } },
    runtime: { kind: "disabled" },
    targets: [
      {
        kind: "coding-agent",
        adapter: extensionId("property-target"),
        features: ["instructions"],
        settings
      }
    ],
    packs: [],
    generation: {
      sourceDirectory: ".aiyoke/source",
      lockFile: ".aiyoke/lock.json",
      lineEndings: "lf"
    }
  };
}

function compiler(
  workspace: MemoryWorkspace,
  paths: readonly string[],
  ownership: "generated" | "managed-section" = "generated"
): HarnessCompiler {
  const descriptor = {
    kind: "target" as const,
    id: extensionId("property-target"),
    version: "1.0.0",
    apiVersion: EXTENSION_API_VERSION as typeof EXTENSION_API_VERSION,
    displayName: "Property target",
    description: "Deterministic property-test target.",
    capabilities: [],
    requires: [],
    conflicts: []
  };
  const target: TargetExtension = {
    descriptor,
    surface: "coding-agent",
    async render() {
      return paths.map(
        (path): ArtifactIntent =>
          ownership === "managed-section"
            ? {
                path,
                content: "generated\n",
                source: "property-target",
                executable: false,
                ownership,
                markers: { start: START, end: END }
              }
            : {
                path,
                content: "generated\n",
                source: "property-target",
                executable: false,
                ownership
              }
      );
    },
    async verify() {
      return [];
    }
  };
  const registry = new ExtensionRegistry()
    .registerTarget({ descriptor, load: async () => target })
    .freeze();
  return new HarnessCompiler(registry, workspace, sha256);
}

const userText = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?_-\n"),
    {
      maxLength: 160
    }
  )
  .map((characters) => characters.join(""));

const safePath = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/), { minLength: 1, maxLength: 4 })
  .map((parts) => `${parts.join("/")}.md`);

const settings = fc.dictionary(
  fc.stringMatching(/^[a-z][a-zA-Z0-9_-]{0,10}$/),
  fc.oneof(fc.string({ maxLength: 30 }), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 8 }
);

function operationSnapshot(plan: Awaited<ReturnType<HarnessCompiler["plan"]>>): unknown {
  return plan.operations.map((operation) =>
    operation.kind === "conflict"
      ? operation
      : {
          kind: operation.kind,
          path: operation.artifact.path,
          content: operation.artifact.content,
          source: operation.artifact.source,
          ownership: operation.artifact.ownership
        }
  );
}

describe("compiler critical-path properties", () => {
  it("preserves all text outside a managed section and becomes idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(userText, userText, fc.boolean(), async (prefix, suffix, existing) => {
        const workspace = new MemoryWorkspace();
        const previous = existing
          ? `${prefix}${START}\nold generated text\n${END}\n${suffix}`
          : `${prefix}${suffix}`;
        workspace.values.set("AGENT.md", previous);
        const harness = compiler(workspace, ["AGENT.md"], "managed-section");

        const plan = await harness.plan(spec());
        await harness.apply(plan);
        const result = workspace.values.get("AGENT.md");
        expect(result).toBeDefined();
        if (result === undefined) return;

        if (existing) {
          expect(result).toBe(`${prefix}${START}\ngenerated\n${END}\n${suffix}`);
        } else {
          expect(result.startsWith(previous)).toBe(true);
          expect(result.slice(previous.length)).toMatch(
            new RegExp(`^(?:\\n{0,2})${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
          );
        }
        expect(result.match(new RegExp(START, "g"))).toHaveLength(1);
        expect(result.match(new RegExp(END, "g"))).toHaveLength(1);
        expect(
          (await harness.plan(spec())).operations.every((item) => item.kind === "unchanged")
        ).toBe(true);
      }),
      { numRuns: RUNS }
    );
  });

  it("keeps operation order and plan fingerprints stable across input ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(safePath, { minLength: 1, maxLength: 10 }),
        settings,
        async (paths, targetSettings) => {
          const reversedSettings = Object.fromEntries(Object.entries(targetSettings).reverse());
          const leftHarness = compiler(new MemoryWorkspace(), paths);
          const rightHarness = compiler(new MemoryWorkspace(), [...paths].reverse());

          const left = await leftHarness.plan(spec(targetSettings));
          const repeated = await leftHarness.plan(spec(targetSettings));
          const reordered = await rightHarness.plan(spec(reversedSettings));

          expect(repeated.fingerprint).toBe(left.fingerprint);
          expect(operationSnapshot(repeated)).toEqual(operationSnapshot(left));
          expect(reordered.fingerprint).toBe(left.fingerprint);
          expect(operationSnapshot(reordered)).toEqual(operationSnapshot(left));
        }
      ),
      { numRuns: RUNS }
    );
  });
});
