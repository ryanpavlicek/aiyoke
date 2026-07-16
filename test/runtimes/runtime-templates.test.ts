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

const testFileNames = new Map([
  ["typescript", "runtime.test.ts"],
  ["javascript", "runtime.test.js"],
  ["python", "test_runtime.py"],
  ["go", "runtime_test.go"],
  ["rust", "runtime_test.rs"]
]);

const frameworkIntegrations: ReadonlyMap<
  string,
  readonly (readonly [framework: string, path: string])[]
> = new Map([
  [
    "typescript",
    [
      ["nextjs", "integrations/nextjs.ts"],
      ["nestjs", "integrations/nestjs.ts"],
      ["fastify", "integrations/fastify.ts"],
      ["express", "integrations/express.ts"]
    ]
  ],
  [
    "javascript",
    [
      ["nextjs", "integrations/nextjs.js"],
      ["fastify", "integrations/fastify.js"],
      ["express", "integrations/express.js"]
    ]
  ],
  [
    "python",
    [
      ["fastapi", "fastapi_aiyoke.py"],
      ["django", "django_aiyoke.py"],
      ["flask", "flask_aiyoke.py"]
    ]
  ],
  [
    "go",
    [
      ["chi", "chi_aiyoke.go"],
      ["gin", "gin_aiyoke.go"],
      ["fiber", "fiber_aiyoke.go"]
    ]
  ],
  [
    "rust",
    [
      ["axum", "axum_aiyoke.rs"],
      ["actix", "actix_aiyoke.rs"]
    ]
  ]
]);

const providerArtifacts = new Map([
  ["go", ["responses_provider.go", "responses_provider_test.go"]],
  ["javascript", ["providers/responses.js", "providers/responses.test.js"]],
  ["python", ["providers/__init__.py", "providers/responses.py", "providers/test_responses.py"]],
  ["rust", ["responses_provider.rs", "responses_provider_test.rs"]],
  ["typescript", ["providers/responses.ts", "providers/responses.test.ts"]]
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
        targets: [],
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
      const expectedTestFile = testFileNames.get(language);
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        `aiyoke-runtime/${language}/${expectedFile}`,
        `aiyoke-runtime/${language}/${expectedTestFile}`,
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

  it("renders only registered framework adapters for the selected language scope", async () => {
    for (const runtime of await loadedRuntimes()) {
      const language = runtime.descriptor.language;
      const integrations = frameworkIntegrations.get(language);
      if (integrations === undefined) throw new Error(`${language} integrations missing`);
      const spec = {
        ...defaultHarnessSpec("framework-runtime"),
        targets: [],
        composition: {
          kind: "single" as const,
          stack: {
            languages: [language],
            frameworks: integrations.map(([framework]) => extensionId(framework))
          }
        }
      };
      if (spec.runtime.kind !== "enabled") throw new Error("runtime must be enabled");
      const artifacts = await runtime.render({
        spec,
        workspace,
        runtime: spec.runtime,
        scope: { kind: "project", stack: spec.composition.stack }
      });
      expect(artifacts.slice(4).map((artifact) => artifact.path)).toEqual(
        integrations.map(([, path]) => `aiyoke-runtime/${language}/${path}`)
      );
      for (const artifact of artifacts.slice(4)) {
        expect(artifact.content).not.toMatch(/\bTODO\b/i);
        expect(artifact.content).toMatch(/HarnessRuntime|runtime\.execute|runtime\.Execute/);
      }
      const guidance = artifacts.find((artifact) => artifact.path.endsWith("README.md"));
      for (const [framework] of integrations) {
        expect(guidance?.content).toContain(`\`${framework}\``);
      }
    }
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

  it("keeps JavaScript runtime behavior in lockstep with the typed reference", async () => {
    const runtimes = await loadedRuntimes();
    const render = async (language: string) => {
      const runtime = runtimes.find((candidate) => candidate.descriptor.language === language);
      if (runtime === undefined) throw new Error(`${language} runtime missing`);
      const spec = defaultHarnessSpec("runtime-parity");
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
    const typeScript = await render("typescript");
    const javaScript = await render("javascript");
    for (const artifactIndex of [0, 1]) {
      const transpiled = ts.transpileModule(typeScript[artifactIndex]?.content ?? "", {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
      }).outputText;
      expect(javaScript[artifactIndex]?.content).toBe(transpiled);
    }
  });

  it("renders only provider artifacts registered for selected targets", async () => {
    for (const runtime of await loadedRuntimes()) {
      const language = runtime.descriptor.language;
      const spec = {
        ...defaultHarnessSpec("provider-runtime"),
        composition: {
          kind: "single" as const,
          stack: { languages: [language], frameworks: [] }
        },
        targets: [
          {
            kind: "inference-gateway" as const,
            adapter: extensionId("openrouter"),
            routing: {
              kind: "fixed" as const,
              model: "test/model"
            },
            settings: {}
          }
        ]
      };
      if (spec.runtime.kind !== "enabled") throw new Error("runtime must be enabled");
      const artifacts = await runtime.render({
        spec,
        workspace,
        runtime: spec.runtime,
        scope: { kind: "project", stack: spec.composition.stack }
      });
      expect(artifacts.slice(4).map((artifact) => artifact.path)).toEqual(
        (providerArtifacts.get(language) ?? []).map((path) => `aiyoke-runtime/${language}/${path}`)
      );
      for (const artifact of artifacts.slice(4)) {
        expect(artifact.content).not.toMatch(/process\.env|Deno\.env|\.env\b/);
      }
      if (artifacts.length > 4) {
        expect(
          artifacts
            .slice(4)
            .map((artifact) => artifact.content)
            .join("\n")
        ).toMatch(/SecretResolver|resolveSecret/);
      }
    }
  });
});
