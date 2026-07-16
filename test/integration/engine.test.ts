import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { AiyokeEngine } from "../../src/engine/index.js";
import type { CapabilityPackExtension, ExtensionLoader } from "../../src/extension-sdk/index.js";
import { createAiyoke, EXTENSION_API_VERSION, extensionId } from "../../src/index.js";
import {
  parseSchemaDocument,
  stringifyHarnessSpec
} from "../../src/infrastructure/config/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("first-release workflow", () => {
  it("previews, migrates, backs up, and rolls back schema v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-migration-"));
    temporaryRoots.push(root);
    const initialEngine = await AiyokeEngine.open(root);
    const current = (await initialEngine.initialize()).spec;
    if (current.composition.kind !== "single") throw new Error("default must be single");
    const legacy = stringify({
      schemaVersion: 1,
      project: current.project,
      stack: current.composition.stack,
      targets: current.targets,
      packs: current.packs,
      generation: current.generation
    });
    await writeFile(join(root, "aiyoke.yaml"), legacy, "utf8");

    const engine = await AiyokeEngine.open(root);
    await expect(engine.loadSpec()).rejects.toThrow(/aiyoke migrate/);
    const preview = await engine.migrate({ dryRun: true });
    expect(preview).toMatchObject({
      operation: "migrate",
      fromVersion: 1,
      toVersion: 3,
      changed: true,
      dryRun: true
    });
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(legacy);

    const migrated = await engine.migrate();
    expect(migrated.backupPath).toMatch(/^\.aiyoke\/backups\/aiyoke\.v1-/);
    expect(
      parseSchemaDocument(await readFile(join(root, "aiyoke.yaml"), "utf8")).schemaVersion
    ).toBe(3);
    if (migrated.backupPath === undefined) throw new Error("migration backup missing");
    expect(await readFile(join(root, migrated.backupPath), "utf8")).toBe(legacy);

    const rollbackPreview = await engine.rollbackMigration(migrated.backupPath, { dryRun: true });
    expect(rollbackPreview).toMatchObject({ operation: "rollback", changed: true, dryRun: true });
    const rolledBack = await engine.rollbackMigration(migrated.backupPath);
    expect(rolledBack.backupPath).toMatch(/^\.aiyoke\/backups\/aiyoke\.v3-/);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(legacy);
  });

  it("refuses corrupt migrations and implicit or lossy downgrades", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-migration-invalid-"));
    temporaryRoots.push(root);
    const engine = await AiyokeEngine.open(root);
    const current = (await engine.initialize()).spec;
    const currentSource = await readFile(join(root, "aiyoke.yaml"), "utf8");

    await expect(engine.migrate({ targetVersion: 1 })).rejects.toThrow(/explicit permission/);
    const downgraded = await engine.migrate({ targetVersion: 1, allowDowngrade: true });
    expect(downgraded.toVersion).toBe(1);
    expect(
      parseSchemaDocument(await readFile(join(root, "aiyoke.yaml"), "utf8")).schemaVersion
    ).toBe(1);

    await writeFile(
      join(root, "aiyoke.yaml"),
      stringify({ schemaVersion: 1, project: current.project }),
      "utf8"
    );
    const corrupt = await AiyokeEngine.open(root);
    const before = await readFile(join(root, "aiyoke.yaml"), "utf8");
    await expect(corrupt.migrate()).rejects.toThrow(/stack must be an object/);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(before);

    await writeFile(
      join(root, "aiyoke.yaml"),
      stringifyHarnessSpec({
        ...current,
        composition: {
          kind: "monorepo",
          root: { languages: [], frameworks: [] },
          workspaces: [
            {
              id: extensionId("api"),
              path: "apps/api",
              stack: { languages: [extensionId("go")], frameworks: [] }
            }
          ]
        }
      }),
      "utf8"
    );
    await expect(
      (await AiyokeEngine.open(root)).migrate({ targetVersion: 1, allowDowngrade: true })
    ).rejects.toThrow(/cannot be represented/);
    expect(currentSource).toContain("schemaVersion: 3");
  });

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
    expect(applied.changedPaths).toContain("aiyoke-runtime/typescript/runtime.ts");

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
    expect(initialized.spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["typescript"], frameworks: ["nextjs"] }
    });
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
    expect(forced.spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["go"], frameworks: [] }
    });
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
        composition: { kind: "single", stack: { languages: [], frameworks: [] } },
        targets: []
      }),
      "utf8"
    );
    const findings = await (await AiyokeEngine.open(root)).doctor();
    expect(findings).toContainEqual(expect.objectContaining({ code: "NO_LANGUAGES" }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "NO_TARGETS" }));
  });

  it("selects built-in target profiles during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-targets-"));
    temporaryRoots.push(root);
    const engine = await AiyokeEngine.open(root);
    const initialized = await engine.initialize({
      targetAdapters: [extensionId("codex"), extensionId("openrouter")]
    });
    expect(initialized.spec.targets.map((target) => target.adapter)).toEqual([
      "codex",
      "openrouter"
    ]);
    await expect(
      engine.initialize({ force: true, targetAdapters: [extensionId("unknown-target")] })
    ).rejects.toThrow(/does not have a built-in initialization profile/);
    await expect(
      engine.initialize({
        force: true,
        targetAdapters: [extensionId("codex"), extensionId("codex")]
      })
    ).rejects.toThrow(/cannot contain duplicates/);
  });

  it("previews and applies validated non-destructive configuration updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-config-"));
    temporaryRoots.push(root);
    const engine = await AiyokeEngine.open(root);
    await engine.initialize();
    const before = await readFile(join(root, "aiyoke.yaml"), "utf8");
    const preview = await engine.configure({
      name: "renamed",
      architecture: "clean",
      languages: [extensionId("go")],
      frameworks: [extensionId("gin")],
      targetAdapters: [extensionId("codex"), extensionId("openrouter")],
      dryRun: true
    });
    expect(preview).toMatchObject({ changed: true, dryRun: true });
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(before);

    const configured = await engine.configure({
      name: "renamed",
      architecture: "clean",
      languages: [extensionId("go")],
      frameworks: [extensionId("gin")],
      targetAdapters: [extensionId("codex"), extensionId("openrouter")]
    });
    expect(configured.backupPath).toMatch(/^\.aiyoke\/backups\/aiyoke\.v3-/);
    expect(configured.spec).toMatchObject({
      project: { name: "renamed", architecture: "clean" },
      composition: {
        kind: "single",
        stack: { languages: ["go"], frameworks: ["gin"] }
      }
    });
    expect(configured.spec.targets.map((target) => target.adapter)).toEqual([
      "codex",
      "openrouter"
    ]);

    const configuredSource = await readFile(join(root, "aiyoke.yaml"), "utf8");
    await expect(
      engine.configure({ languages: [extensionId("missing-language")] })
    ).rejects.toThrow(/not registered/);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(configuredSource);
  });
});
