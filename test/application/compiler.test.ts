import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HarnessCompiler, type HashPort, type WorkspacePort } from "../../src/application/index.js";
import {
  type ArtifactIntent,
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
    schemaVersion: 3,
    project: { name: "example", architecture: "layered" },
    composition: { kind: "single", stack: { languages: [], frameworks: [] } },
    runtime: { kind: "disabled" },
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
  readonly paths?: readonly string[];
  readonly surface?: TargetSpec["kind"];
  readonly verificationWarning?: boolean;
}

function compiler(
  workspace: MemoryWorkspace,
  options: FakeTargetOptions = {},
  hashPort: HashPort = hash
): HarnessCompiler {
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
      const artifacts = (options.paths ?? [options.path ?? "AGENT.md"]).map((path) => {
        const base = { path, content: "generated\r\n", source: "fake", executable: false };
        return options.ownership === "managed-section"
          ? ({
              ...base,
              ownership: "managed-section",
              markers: {
                start: "<!-- aiyoke:managed:start -->",
                end: "<!-- aiyoke:managed:end -->"
              }
            } satisfies ArtifactIntent)
          : ({ ...base, ownership: options.ownership ?? "generated" } satisfies ArtifactIntent);
      });
      const first = artifacts[0];
      if (first === undefined) return [];
      return options.conflicting
        ? [...artifacts, { ...first, content: "different", source: "other" }]
        : artifacts;
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
  return new HarnessCompiler(registry, workspace, hashPort);
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

  it("hashes semantically identical specifications canonically", async () => {
    const sha256: HashPort = {
      digest: (value) => createHash("sha256").update(value).digest("hex")
    };
    const left = spec();
    const right = spec();
    const leftTarget = left.targets[0];
    const rightTarget = right.targets[0];
    if (leftTarget === undefined || rightTarget === undefined)
      throw new Error("Missing fixture target.");
    const leftSpec: HarnessSpec = {
      ...left,
      targets: [
        {
          ...leftTarget,
          settings: { nested: { z: 1, a: 2 }, "\u{10000}": "astral", "\uE000": "bmp" }
        }
      ]
    };
    const rightSpec: HarnessSpec = {
      ...right,
      targets: [
        {
          ...rightTarget,
          settings: { "\uE000": "bmp", "\u{10000}": "astral", nested: { a: 2, z: 1 } }
        }
      ]
    };

    const leftPlan = await compiler(new MemoryWorkspace(), {}, sha256).plan(leftSpec);
    const rightPlan = await compiler(new MemoryWorkspace(), {}, sha256).plan(rightSpec);
    const lockContent = (plan: typeof leftPlan) => {
      const lock = plan.operations.find(
        (operation) =>
          operation.kind !== "conflict" && operation.artifact.path === ".aiyoke/lock.json"
      );
      if (lock === undefined || lock.kind === "conflict") throw new Error("Missing lock artifact.");
      return JSON.parse(lock.artifact.content) as { readonly specDigest: string };
    };

    expect(lockContent(leftPlan).specDigest).toBe(lockContent(rightPlan).specDigest);
    expect(leftPlan.fingerprint).toBe(rightPlan.fingerprint);
  });

  it("orders generated paths by Unicode code point", async () => {
    const privateUse = "\uE000.md";
    const astral = "\u{10000}.md";
    const plan = await compiler(new MemoryWorkspace(), { paths: [astral, privateUse] }).plan(
      spec()
    );

    expect(
      plan.operations.map((operation) =>
        operation.kind === "conflict" ? operation.path : operation.artifact.path
      )
    ).toEqual([".aiyoke/lock.json", privateUse, astral]);
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

  it("updates generated artifacts and protects user-owned content", async () => {
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

    const userWorkspace = new MemoryWorkspace();
    userWorkspace.values.set("AGENT.md", "user content\n");
    const userPlan = await compiler(userWorkspace, { ownership: "user-owned" }).plan(spec());
    expect(userPlan.operations).toContainEqual(
      expect.objectContaining({ kind: "conflict", path: "AGENT.md" })
    );
  });

  it("appends and updates a bounded managed section without changing user content", async () => {
    const workspace = new MemoryWorkspace();
    workspace.values.set("AGENT.md", "# Team instructions\n\nKeep this paragraph.\n");
    const harness = compiler(workspace, { ownership: "managed-section" });
    const first = await harness.plan(spec());
    expect(first.operations).toContainEqual(
      expect.objectContaining({
        kind: "update",
        artifact: expect.objectContaining({ path: "AGENT.md" })
      })
    );
    await harness.apply(first);
    expect(workspace.values.get("AGENT.md")).toBe(
      "# Team instructions\n\nKeep this paragraph.\n\n<!-- aiyoke:managed:start -->\ngenerated\n<!-- aiyoke:managed:end -->\n"
    );
    expect(
      (await harness.plan(spec())).operations.every((operation) => operation.kind === "unchanged")
    ).toBe(true);

    workspace.values.set(
      "AGENT.md",
      "before\n\n<!-- aiyoke:managed:start -->\nold\n<!-- aiyoke:managed:end -->\n\nafter\n"
    );
    await harness.apply(await harness.plan(spec()));
    expect(workspace.values.get("AGENT.md")).toBe(
      "before\n\n<!-- aiyoke:managed:start -->\ngenerated\n<!-- aiyoke:managed:end -->\n\nafter\n"
    );
  });

  it("conflicts on ambiguous or modified legacy managed markers", async () => {
    const workspace = new MemoryWorkspace();
    const harness = compiler(workspace, { ownership: "managed-section" });
    workspace.values.set("AGENT.md", "<!-- aiyoke:managed:start -->\nmissing end\n");
    expect(await harness.plan(spec())).toEqual(
      expect.objectContaining({
        operations: expect.arrayContaining([
          expect.objectContaining({ kind: "conflict", path: "AGENT.md" })
        ])
      })
    );

    workspace.values.set("AGENT.md", "<!-- aiyoke:generated -->\nmodified\n");
    expect(await harness.plan(spec())).toEqual(
      expect.objectContaining({
        operations: expect.arrayContaining([
          expect.objectContaining({ kind: "conflict", path: "AGENT.md" })
        ])
      })
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
