import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { frameworkLoaders } from "../../src/extensions/frameworks/index.js";
import { languageLoaders } from "../../src/extensions/languages/index.js";
import { runtimeLoaders } from "../../src/extensions/runtimes/index.js";
import * as targets from "../../src/extensions/targets/index.js";

const extensionRoot = fileURLToPath(new URL("../../src/extensions/", import.meta.url));

describe("built-in loader export conventions", () => {
  it("uses createXLoader for factories and xLoader for instances", async () => {
    for (const directory of ["languages", "frameworks", "runtimes", "targets"]) {
      for (const entry of await readdir(join(extensionRoot, directory), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const source = await readFile(join(extensionRoot, directory, entry.name), "utf8");
        expect(source).not.toMatch(/export const \w+Loader\s*=\s*create\w+Loader;/u);
      }
    }

    const targetKeys = Object.keys(targets).sort();
    expect(targetKeys).toEqual(
      [
        "chatGptLoader",
        "chatGptTarget",
        "claudeCodeLoader",
        "claudeCodeTarget",
        "codexLoader",
        "codexTarget",
        "createChatGptLoader",
        "createClaudeCodeLoader",
        "createCodexLoader",
        "createGrokBuildLoader",
        "createOpenRouterLoader",
        "createXaiApiLoader",
        "grokBuildLoader",
        "grokBuildTarget",
        "openRouterLoader",
        "openRouterTarget",
        "xaiApiLoader",
        "xaiApiTarget"
      ].sort()
    );

    const targetLoaders = Object.entries(targets)
      .filter(([name]) => name.endsWith("Loader") && !name.startsWith("create"))
      .map(([, loader]) => loader);
    for (const loader of [
      ...languageLoaders,
      ...frameworkLoaders,
      ...runtimeLoaders,
      ...targetLoaders
    ]) {
      expect(loader).toEqual(expect.objectContaining({ load: expect.any(Function) }));
    }
  });

  it("centralizes the generic static-extension loader", async () => {
    const candidates = await Promise.all(
      [
        "shared/loader.ts",
        "shared/target.ts",
        "languages/shared.ts",
        "frameworks/shared.ts",
        "runtimes/shared.ts"
      ].map((path) => readFile(join(extensionRoot, path), "utf8"))
    );
    expect(candidates.join("\n").match(/export function loaderFor/gu)).toHaveLength(1);
  });
});
