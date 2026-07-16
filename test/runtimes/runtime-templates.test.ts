import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extensionId } from "../../src/core/index.js";
import type { RuntimeTemplateExtension } from "../../src/extension-sdk/index.js";
import { runtimeLoaders } from "../../src/extensions/runtimes/index.js";
import { defaultHarnessSpec } from "../../src/infrastructure/config/index.js";

const fileNames = new Map([
  ["typescript", "runtime.ts"],
  ["javascript", "runtime.js"],
  ["python", "runtime.py"],
  ["go", "runtime.go"],
  ["rust", "runtime.rs"]
]);

const workspace = {
  root: "/workspace",
  files: [] as readonly string[],
  read: async () => undefined,
  exists: async () => false
};

async function loadedRuntimes(): Promise<readonly RuntimeTemplateExtension[]> {
  return Promise.all(
    runtimeLoaders.map(async (loader) => (await loader.load()) as RuntimeTemplateExtension)
  );
}

describe("runtime template extensions", () => {
  it("registers all supported languages with the complete capability surface", async () => {
    const runtimes = await loadedRuntimes();
    expect(runtimes.map((runtime) => runtime.descriptor.language)).toEqual([
      "go",
      "javascript",
      "python",
      "rust",
      "typescript"
    ]);
    for (const runtime of runtimes) {
      expect(runtime.descriptor.capabilities).toEqual(
        expect.arrayContaining([
          "reliability",
          "observability",
          "evaluation",
          "safety",
          "provider-portability",
          "cost-control",
          "concurrency"
        ])
      );
    }
  });

  it("renders owned source, resolved policy, and guidance per language", async () => {
    for (const runtime of await loadedRuntimes()) {
      const language = runtime.descriptor.language;
      const spec = {
        ...defaultHarnessSpec("runtime"),
        composition: {
          kind: "single" as const,
          stack: { languages: [language], frameworks: [] }
        }
      };
      if (spec.runtime.kind !== "enabled") throw new Error("runtime must be enabled");
      const artifacts = await runtime.render({
        spec,
        workspace,
        runtime: spec.runtime,
        scope: { kind: "project", stack: spec.composition.stack }
      });
      const expectedFile = fileNames.get(language);
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        `aiyoke-runtime/${language}/${expectedFile}`,
        `aiyoke-runtime/${language}/policy.json`,
        `aiyoke-runtime/${language}/README.md`
      ]);
      expect(artifacts.every((artifact) => artifact.ownership === "generated")).toBe(true);
      const policy = artifacts.find((artifact) => artifact.path.endsWith("policy.json"));
      expect(JSON.parse(policy?.content ?? "")).toMatchObject({
        schemaVersion: 1,
        policy: { reliability: { timeoutMs: 30_000 } }
      });
    }
  });

  it("prefixes monorepo workspace paths without trusting template output", async () => {
    const runtime = (await loadedRuntimes()).find(
      (candidate) => candidate.descriptor.language === "python"
    );
    if (runtime === undefined) throw new Error("python runtime missing");
    const spec = defaultHarnessSpec("runtime");
    if (spec.runtime.kind !== "enabled") throw new Error("runtime must be enabled");
    const artifacts = await runtime.render({
      spec,
      workspace,
      runtime: spec.runtime,
      scope: {
        kind: "workspace",
        id: extensionId("api"),
        path: "services/api",
        stack: { languages: [extensionId("python")], frameworks: [] }
      }
    });
    expect(artifacts[0]?.path).toBe("services/api/aiyoke-runtime/python/runtime.py");
  });

  it("emits valid TypeScript and executable deterministic JavaScript primitives", async () => {
    const runtimes = await loadedRuntimes();
    const render = async (language: string) => {
      const runtime = runtimes.find((candidate) => candidate.descriptor.language === language);
      if (runtime === undefined) throw new Error(`${language} runtime missing`);
      const spec = defaultHarnessSpec("runtime");
      if (spec.runtime.kind !== "enabled" || spec.composition.kind !== "single") {
        throw new Error("default runtime shape changed");
      }
      return runtime.render({
        spec,
        workspace,
        runtime: spec.runtime,
        scope: { kind: "project", stack: spec.composition.stack }
      });
    };

    const typeScript = (await render("typescript"))[0]?.content ?? "";
    const transpiled = ts.transpileModule(typeScript, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true
    });
    expect(
      transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
      ) ?? []
    ).toEqual([]);

    const javaScript = (await render("javascript"))[0]?.content ?? "";
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(javaScript).toString("base64")}`
    )) as {
      retryDelayMs: (...args: [number, number, number, number, () => number]) => number;
      CircuitBreaker: new (
        threshold: number,
        reset: number
      ) => {
        allow(now: number): boolean;
        failure(now: number): void;
        success(): void;
      };
    };
    expect(module.retryDelayMs(2, 100, 1_000, 0.5, () => 0)).toBe(200);
    const breaker = new module.CircuitBreaker(2, 100);
    breaker.failure(0);
    expect(breaker.allow(1)).toBe(true);
    breaker.failure(2);
    expect(breaker.allow(50)).toBe(false);
    expect(breaker.allow(102)).toBe(true);
    breaker.success();
    expect(breaker.allow(103)).toBe(true);
  });
});
