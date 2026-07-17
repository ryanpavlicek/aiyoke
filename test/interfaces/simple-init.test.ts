import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionId } from "../../src/core/index.js";
import { createAiyoke } from "../../src/index.js";
import { parseHarnessSpec } from "../../src/infrastructure/config/index.js";
import { runCli } from "../../src/interfaces/cli/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("simple initialization preset", () => {
  it("auto-detects the stack while selecting only Claude Code and OpenRouter", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-simple-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      '{"name":"simple-app","dependencies":{"next":"16.2.10"}}\n',
      "utf8"
    );
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runCli(["init", "--root", root, "--preset", "simple"])).toBe(0);
    const spec = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    expect(spec.targets.map((target) => target.adapter)).toEqual(["claude-code", "openrouter"]);
    expect(spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["typescript"], frameworks: ["nextjs"] }
    });
  });

  it("lets explicit flags override preset selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-simple-override-"));
    temporaryRoots.push(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      await runCli([
        "init",
        "--root",
        root,
        "--preset",
        "simple",
        "--languages",
        "python",
        "--frameworks",
        "fastapi",
        "--targets",
        "codex,openrouter"
      ])
    ).toBe(0);
    const spec = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    expect(spec.targets.map((target) => target.adapter)).toEqual(["codex", "openrouter"]);
    expect(spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["python"], frameworks: ["fastapi"] }
    });
  });

  it("reports unknown presets without writing a configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-simple-unknown-"));
    temporaryRoots.push(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runCli(["init", "--root", root, "--preset", "unknown", "--json"])).toBe(1);
    await expect(readFile(join(root, "aiyoke.yaml"), "utf8")).rejects.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown initialization preset"));
  });

  it("accepts custom presets through the lazy public facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-custom-preset-"));
    temporaryRoots.push(root);
    const engine = await createAiyoke({
      root,
      initPresets: [
        {
          id: extensionId("gateway-only"),
          displayName: "Gateway only",
          description: "A test preset that keeps only the gateway target.",
          select: () => ({ targetAdapters: [extensionId("openrouter")] })
        }
      ]
    });

    expect(engine.listInitPresets().map((preset) => preset.id)).toEqual(["gateway-only", "simple"]);
    const result = await engine.initialize({ preset: extensionId("gateway-only") });
    expect(result.spec.targets.map((target) => target.adapter)).toEqual(["openrouter"]);
  });

  it("validates custom preset selections before writing configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-invalid-preset-"));
    temporaryRoots.push(root);
    const engine = await createAiyoke({
      root,
      initPresets: [
        {
          id: extensionId("missing-language-preset"),
          displayName: "Missing language",
          description: "An intentionally invalid test preset.",
          select: () => ({ languages: [extensionId("missing-language")] })
        }
      ]
    });

    await expect(
      engine.initialize({ preset: extensionId("missing-language-preset") })
    ).rejects.toThrow(/not registered/);
    await expect(readFile(join(root, "aiyoke.yaml"), "utf8")).rejects.toThrow();
  });
});
