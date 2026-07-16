import { describe, expect, it } from "vitest";
import { HarnessCompiler, type HashPort, type WorkspacePort } from "../../src/application/index.js";
import {
  type ArtifactOwnership,
  extensionId,
  type HarnessSpec,
  type TargetSpec
} from "../../src/core/index.js";
import {
  EXTENSION_API_VERSION,
  ExtensionRegistry,
  type TargetExtension
} from "../../src/extension-sdk/index.js";

class MemoryWorkspace implements WorkspacePort {
  readonly root = "/workspace";
  readonly files: readonly string[] = [];
  readonly values = new Map<string, string>();
  writes = 0;

  async read(path: string): Promise<string | undefined> {
    return this.values.get(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.values.has(path);
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.writes += 1;
    this.values.set(path, content);
  }
}

const hash: HashPort = {
  digest: (value) => `hash-${value.length}`
};

function spec(): HarnessSpec {
  return {
    schemaVersion: 1,
    project: { name: "example", architecture: "layered" },
    stack: { languages: [], frameworks: [] },
    targets: [
      {
        kind: "coding-agent",
        adapter: extensionId("fake"),
        features: ["instructions"],
        settings: {}
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

interface FakeTargetOptions {
  readonly conflicting?: boolean;
  readonly ownership?: ArtifactOwnership;
  readonly path?: string;
  readonly surface?: TargetSpec["kind"];
  readonly verificationWarning?: boolean;
}

function compiler(workspace: MemoryWorkspace, options: FakeTargetOptions = {}): HarnessCompiler {
  const descriptor = {
    kind: "target" as const,
    id: extensionId("fake"),
    version: "1.0.0",
    apiVersion: EXTENSION_API_VERSION as typeof EXTENSION_API_VERSION,
    displayName: "Fake",
    description: "Fake target",
    capabilities: [],
    requires: [],
    conflicts: []
  };
  const target: TargetExtension = {
    descriptor,
    surface: options.surface ?? "coding-agent",
    async render() {
      const first = {
        path: options.path ?? "AGENT.md",
        content: "generated\r\n",
        ownership: options.ownership ?? "generated",
        source: "fake",
        executable: false
      };
      return options.conflicting
        ? [first, { ...first, content: "different", source: "other" }]
        : [first];
    },
    async verify() {
      return options.verificationWarning
        ? [{ severity: "warning", code: "FAKE_WARNING", message: "Fake warning" }]
        : [];
    }
  };
  const registry = new ExtensionRegistry()
    .registerTarget({ descriptor, load: async () => target })
    .freeze();
  return new HarnessCompiler(registry, workspace, hash);
}

describe("HarnessCompiler", () => {
  it("plans without writing, applies atomically, and becomes idempotent", async () => {
    const workspace = new MemoryWorkspace();
    const harness = compiler(workspace);
    const first = await harness.plan(spec());
    expect(workspace.writes).toBe(0);
    expect(first.operations.map((operation) => operation.kind)).toEqual(["create", "create"]);

    const applied = await harness.apply(first);
    expect(applied.changedPaths).toEqual([".aiyoke/lock.json", "AGENT.md"]);
    expect(workspace.writes).toBe(2);

    const second = await harness.plan(spec());
    expect(second.operations.every((operation) => operation.kind === "unchanged")).toBe(true);
    expect((await harness.apply(second)).changedPaths).toEqual([]);
    expect(workspace.writes).toBe(2);
  });

  it("turns incompatible extension output into a plan conflict", async () => {
    const harness = compiler(new MemoryWorkspace(), { conflicting: true });
    const plan = await harness.plan(spec());
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "conflict", path: "AGENT.md" })
    );
    await expect(harness.apply(plan)).rejects.toThrow(/artifact conflict/);
  });

  it("refuses a stale plan before performing any writes", async () => {
    const workspace = new MemoryWorkspace();
    const harness = compiler(workspace);
    const plan = await harness.plan(spec());
    workspace.values.set("AGENT.md", "concurrent user content\n");

    await expect(harness.apply(plan)).rejects.toThrow(/changed after this plan/);
    expect(workspace.writes).toBe(0);
    expect(workspace.values.get("AGENT.md")).toBe("concurrent user content\n");
  });

  it("updates generated artifacts and protects non-generated ownership", async () => {
    const generatedWorkspace = new MemoryWorkspace();
    generatedWorkspace.values.set("AGENT.md", "old\n");
    const generated = compiler(generatedWorkspace);
    const updatePlan = await generated.plan(spec());
    expect(updatePlan.operations).toContainEqual(
      expect.objectContaining({
        kind: "update",
        artifact: expect.objectContaining({ path: "AGENT.md" })
      })
    );
    expect((await generated.apply(updatePlan)).changedPaths).toContain("AGENT.md");

    const managedWorkspace = new MemoryWorkspace();
    managedWorkspace.values.set("AGENT.md", "user content\n");
    const managedPlan = await compiler(managedWorkspace, { ownership: "managed-section" }).plan(
      spec()
    );
    expect(managedPlan.operations).toContainEqual(
      expect.objectContaining({ kind: "conflict", path: "AGENT.md" })
    );
  });

  it("validates target surfaces and generated paths", async () => {
    await expect(
      compiler(new MemoryWorkspace(), { surface: "chat-plugin" }).plan(spec())
    ).rejects.toThrow(/supports chat-plugin/);
    await expect(
      compiler(new MemoryWorkspace(), { path: "../outside" }).plan(spec())
    ).rejects.toThrow(/Unsafe generated path/);
  });

  it("combines drift and target-specific verification findings", async () => {
    const findings = await compiler(new MemoryWorkspace(), { verificationWarning: true }).verify(
      spec()
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      "GENERATED_DRIFT",
      "GENERATED_DRIFT",
      "FAKE_WARNING"
    ]);
  });
});
