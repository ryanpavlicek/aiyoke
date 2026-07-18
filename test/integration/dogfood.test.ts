import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AiyokeEngine } from "../../src/engine/index.js";

interface DogfoodFixture {
  readonly name: string;
  readonly directory: string;
  readonly language: string;
  readonly framework: string;
  readonly languageTitle: string;
  readonly frameworkTitle: string;
}

const fixtures: readonly DogfoodFixture[] = [
  {
    name: "Python with FastAPI",
    directory: "python-fastapi",
    language: "python",
    framework: "fastapi",
    languageTitle: "Python language module",
    frameworkTitle: "FastAPI framework module"
  },
  {
    name: "TypeScript with Next.js",
    directory: "typescript-nextjs",
    language: "typescript",
    framework: "nextjs",
    languageTitle: "TypeScript language module",
    frameworkTitle: "Next.js framework module"
  },
  {
    name: "JavaScript with Express",
    directory: "javascript-express",
    language: "javascript",
    framework: "express",
    languageTitle: "JavaScript language module",
    frameworkTitle: "Express framework module"
  },
  {
    name: "Rust with Axum",
    directory: "rust-axum",
    language: "rust",
    framework: "axum",
    languageTitle: "Rust language module",
    frameworkTitle: "Axum framework module"
  },
  {
    name: "Go with Gin",
    directory: "go-gin",
    language: "go",
    framework: "gin",
    languageTitle: "Go language module",
    frameworkTitle: "Gin framework module"
  }
];

const fixtureRoot = fileURLToPath(new URL("../fixtures/dogfood/", import.meta.url));
const temporaryRoots: string[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

describe("dogfood project matrix", () => {
  it.each(fixtures)(
    "generates and validates every target for $name",
    async (fixture) => {
      const root = await mkdtemp(join(tmpdir(), "aiyoke-dogfood-"));
      temporaryRoots.push(root);
      await cp(join(fixtureRoot, fixture.directory), root, { recursive: true });

      const engine = await AiyokeEngine.open(root);
      const detected = await engine.detect();
      expect(detected).toContainEqual(
        expect.objectContaining({ descriptor: expect.objectContaining({ id: fixture.language }) })
      );
      expect(detected).toContainEqual(
        expect.objectContaining({ descriptor: expect.objectContaining({ id: fixture.framework }) })
      );

      const initialized = await engine.initialize();
      expect(initialized.spec.composition).toEqual({
        kind: "single",
        stack: { languages: [fixture.language], frameworks: [fixture.framework] }
      });

      const plan = await engine.plan();
      expect(plan.operations.every((operation) => operation.kind === "create")).toBe(true);
      const applied = await engine.apply();
      expect(applied.changedPaths).toEqual(
        expect.arrayContaining([
          "CLAUDE.md",
          "AGENTS.md",
          ".agents/plugins/marketplace.json",
          ".xai/provider.json",
          ".openrouter/config.json",
          `aiyoke-runtime/${fixture.language}/runtime.${
            fixture.language === "typescript"
              ? "ts"
              : fixture.language === "javascript"
                ? "js"
                : fixture.language === "python"
                  ? "py"
                  : fixture.language === "rust"
                    ? "rs"
                    : "go"
          }`,
          ".aiyoke/lock.json"
        ])
      );

      const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
      expect(instructions).toContain(fixture.languageTitle);
      expect(instructions).toContain(fixture.frameworkTitle);
      expect(await readFile(join(root, ".xai", "provider.json"), "utf8")).toContain("XAI_API_KEY");
      expect(await readFile(join(root, ".openrouter", "config.json"), "utf8")).toContain(
        "OPENROUTER_API_KEY"
      );

      const reopened = await AiyokeEngine.open(root);
      expect((await reopened.check()).filter((finding) => finding.severity === "error")).toEqual(
        []
      );
      expect((await reopened.apply()).changedPaths).toEqual([]);
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );
});
