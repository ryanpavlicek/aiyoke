import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiyokeEngine } from "../../src/engine/index.js";
import type { CapabilityPackExtension, ExtensionLoader } from "../../src/extension-sdk/index.js";
import { createAiyoke, EXTENSION_API_VERSION, extensionId } from "../../src/index.js";
import { stringifyHarnessSpec } from "../../src/infrastructure/config/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("first-release workflow", () => {
  it("initializes, previews, applies, checks, and reapplies without changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-"));
    temporaryRoots.push(root);
    const engine = await AiyokeEngine.open(root);

    expect((await engine.initialize()).created).toBe(true);
    const plan = await engine.plan();
    expect(plan.operations.some((operation) => operation.kind === "create")).toBe(true);
    expect(plan.operations.some((operation) => operation.kind === "conflict")).toBe(false);

    const applied = await engine.apply();
    expect(applied.changedPaths).toContain("CLAUDE.md");
    expect(applied.changedPaths).toContain("AGENTS.md");
    expect(applied.changedPaths).toContain(".xai/provider.json");
    expect(applied.changedPaths).toContain(".openrouter/config.json");

    await writeFile(join(root, ".xai", "provider.json"), "drift\n", "utf8");
    const drifted = await AiyokeEngine.open(root);
    expect((await drifted.check()).some((finding) => finding.code === "GENERATED_DRIFT")).toBe(
      true
    );
    expect((await drifted.apply()).changedPaths).toEqual([".xai/provider.json"]);

    const reopened = await AiyokeEngine.open(root);
    expect((await reopened.apply()).changedPaths).toEqual([]);
    expect((await reopened.check()).filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("accepts additional registered extensions through the lazy facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-extension-"));
    temporaryRoots.push(root);
    const descriptor = {
      kind: "pack" as const,
      id: extensionId("custom-policy"),
      version: "1.0.0",
      apiVersion: EXTENSION_API_VERSION as typeof EXTENSION_API_VERSION,
      displayName: "Custom policy",
      description: "Project-local extension",
      capabilities: [],
      requires: [],
      conflicts: []
    };
    const loader: ExtensionLoader<CapabilityPackExtension> = {
      descriptor,
      load: async () => ({
        descriptor,
        async contribute() {
          return {
            id: "custom-policy",
            title: "Custom policy",
            source: "custom-policy",
            instructions: [],
            skills: [],
            hooks: [],
            mcpServers: [],
            subagents: []
          };
        }
      })
    };

    const engine = await createAiyoke({ root, extensions: [loader] });
    expect(engine.listExtensions().some((item) => item.id === "custom-policy")).toBe(true);
  });

  it("detects a stack, preserves an existing config, and reports health", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-detect-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { next: "latest", typescript: "latest" } }),
      "utf8"
    );
    const engine = await AiyokeEngine.open(root);
    const detectedIds = (await engine.detect()).map((item) => item.descriptor.id);
    expect(detectedIds).toContain("typescript");
    expect(detectedIds).toContain("nextjs");

    const initialized = await engine.initialize();
    expect(initialized.spec.stack.languages).toContain("typescript");
    expect(initialized.spec.stack.frameworks).toContain("nextjs");
    expect((await engine.initialize()).created).toBe(false);
    expect((await engine.doctor()).some((finding) => finding.code === "GENERATED_DRIFT")).toBe(
      true
    );

    await engine.apply();
    const healthy = await (await AiyokeEngine.open(root)).doctor();
    expect(healthy).toContainEqual(expect.objectContaining({ code: "READY" }));

    const forced = await engine.initialize({
      force: true,
      languages: [extensionId("go")],
      frameworks: []
    });
    expect(forced.spec.stack).toEqual({ languages: ["go"], frameworks: [] });
  });

  it("reports absent configuration and empty selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-doctor-"));
    temporaryRoots.push(root);
    const engine = await AiyokeEngine.open(root);
    await expect(engine.loadSpec()).rejects.toThrow(/Run `aiyoke init`/);

    const initialized = await engine.initialize();
    await writeFile(
      join(root, "aiyoke.yaml"),
      stringifyHarnessSpec({
        ...initialized.spec,
        stack: { languages: [], frameworks: [] },
        targets: []
      }),
      "utf8"
    );
    const findings = await (await AiyokeEngine.open(root)).doctor();
    expect(findings).toContainEqual(expect.objectContaining({ code: "NO_LANGUAGES" }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "NO_TARGETS" }));
  });
});
