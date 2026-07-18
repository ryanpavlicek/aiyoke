import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extensionId, type RuntimePolicy } from "../../src/core/index.js";
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

const policyFileNames = new Map([
  ["typescript", "policy.ts"],
  ["javascript", "policy.js"],
  ["python", "policy.py"],
  ["go", "policy.go"],
  ["rust", "policy.rs"]
]);

const capabilityFamilies = [
  "reliability",
  "observability",
  "evaluation-and-iteration",
  "safety-and-control",
  "developer-experience-and-consistency",
  "maintainability-and-portability",
  "cost-and-performance"
] as const;

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

const runtimeModuleArtifacts = new Map([
  ["go", ["tooling.go", "tooling_test.go", "evaluation.go", "evaluation_test.go"]],
  [
    "javascript",
    [
      "modules/tooling.js",
      "modules/tooling.test.js",
      "modules/evaluation.js",
      "modules/evaluation.test.js"
    ]
  ],
  [
    "python",
    [
      "modules/__init__.py",
      "modules/tooling.py",
      "modules/test_tooling.py",
      "modules/evaluation.py",
      "modules/test_evaluation.py"
    ]
  ],
  ["rust", ["tooling.rs", "tooling_test.rs", "evaluation.rs", "evaluation_test.rs"]],
  [
    "typescript",
    [
      "modules/tooling.ts",
      "modules/tooling.test.ts",
      "modules/evaluation.ts",
      "modules/evaluation.test.ts"
    ]
  ]
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
      const expectedPolicyFile = policyFileNames.get(language);
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        `aiyoke-runtime/${language}/${expectedFile}`,
        `aiyoke-runtime/${language}/${expectedTestFile}`,
        `aiyoke-runtime/${language}/conformance.json`,
        `aiyoke-runtime/${language}/policy.json`,
        `aiyoke-runtime/${language}/${expectedPolicyFile}`,
        `aiyoke-runtime/${language}/capabilities.json`,
        `aiyoke-runtime/${language}/README.md`,
        ...(runtimeModuleArtifacts.get(language) ?? []).map(
          (path) => `aiyoke-runtime/${language}/${path}`
        )
      ]);
      expect(artifacts.every((artifact) => artifact.ownership === "generated")).toBe(true);
      const conformance = artifacts.find((artifact) => artifact.path.endsWith("conformance.json"));
      expect(JSON.parse(conformance?.content ?? "")).toMatchObject({
        schemaVersion: 1,
        runtime: {
          synchronousAdapterThrow: "provider-failure",
          guardStages: ["input", "output"]
        }
      });
      const policy = artifacts.find((artifact) => artifact.path.endsWith("policy.json"));
      expect(JSON.parse(policy?.content ?? "")).toMatchObject({
        schemaVersion: 1,
        policy: { reliability: { timeoutMs: 30_000 } }
      });
      const nativePolicy = artifacts.find((artifact) =>
        artifact.path.endsWith(`/${expectedPolicyFile}`)
      );
      expect(nativePolicy?.content).toMatch(/RuntimeOptions|runtimeOptions/);
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

  it("compiles custom and disabled policy variants into every native option module", async () => {
    const policy: RuntimePolicy = {
      reliability: {
        timeoutMs: 1_234,
        retry: { kind: "disabled" },
        circuitBreaker: { kind: "disabled" },
        fallback: { kind: "ordered", routes: ["backup"] },
        maxRepairAttempts: 2
      },
      observability: {
        kind: "events",
        contentCapture: "metadata-only",
        emitTokenUsage: true,
        emitEstimatedCost: true
      },
      evaluation: { kind: "offline" },
      safety: { kind: "guarded", humanApproval: "disabled", audit: "redacted" },
      performance: {
        cache: { kind: "disabled" },
        tokenBudget: { kind: "disabled" },
        costBudget: { kind: "limited", maxEstimatedCostUsd: 0.25 },
        maxConcurrency: 3,
        maxBatchSize: 5
      }
    };
    const fragments = new Map<string, readonly string[]>([
      ["typescript", ["maxAttempts: 1", 'fallbackRoutes: ["backup"]', "maxEstimatedCostUsd: 0.25"]],
      ["javascript", ["maxAttempts: 1", 'fallbackRoutes: ["backup"]', "maxEstimatedCostUsd: 0.25"]],
      ["python", ["max_attempts=1", 'fallback_routes=("backup",)', "max_estimated_cost_usd=0.25"]],
      ["go", ["MaxAttempts: 1", '[]string{"backup"}', "cost := 0.25"]],
      ["rust", ["max_attempts: 1", 'vec!["backup".to_owned()]', "Some(0.25)"]]
    ]);

    for (const runtime of await loadedRuntimes()) {
      const language = runtime.descriptor.language;
      const base = defaultHarnessSpec("custom-policy");
      const spec = {
        ...base,
        composition: {
          kind: "single" as const,
          stack: { languages: [language], frameworks: [] }
        },
        targets: [],
        runtime: {
          kind: "enabled" as const,
          outputDirectory: "aiyoke-runtime",
          profile: { kind: "custom" as const, ...policy }
        }
      };
      const artifacts = await runtime.render({
        spec,
        workspace,
        runtime: spec.runtime,
        scope: { kind: "project", stack: spec.composition.stack }
      });
      const policyFile = policyFileNames.get(language);
      const nativePolicy = artifacts.find((artifact) => artifact.path.endsWith(`/${policyFile}`));
      for (const fragment of fragments.get(language) ?? []) {
        expect(nativePolicy?.content).toContain(fragment);
      }
    }
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
      const integrationPaths = new Set(
        integrations.map(([, path]) => `aiyoke-runtime/${language}/${path}`)
      );
      const renderedIntegrations = artifacts.filter((artifact) =>
        integrationPaths.has(artifact.path)
      );
      expect(renderedIntegrations.map((artifact) => artifact.path)).toEqual([...integrationPaths]);
      for (const artifact of renderedIntegrations) {
        expect(artifact.content).not.toMatch(/\bTODO\b/i);
        expect(artifact.content).toMatch(/HarnessRuntime|runtime\.execute|runtime\.Execute/);
        expect(artifact.content).toContain("499");
      }
      const integrationSource = renderedIntegrations.map((artifact) => artifact.content).join("\n");
      if (language === "python") {
        expect(integrationSource).toContain("cancellation_probe_factory");
        expect(integrationSource).toContain("CancelledError");
      }
      if (language === "rust") {
        expect(integrationSource).toContain("ExecuteOptions");
        expect(integrationSource).toContain("Result<(ModelRequest<I>, ExecuteOptions<O>), String>");
      }
      const guidance = artifacts.find((artifact) => artifact.path.endsWith("README.md"));
      for (const [framework] of integrations) {
        expect(guidance?.content).toContain(`\`${framework}\``);
      }
      const capabilityArtifact = artifacts.find((artifact) =>
        artifact.path.endsWith("capabilities.json")
      );
      const capabilityManifest = JSON.parse(capabilityArtifact?.content ?? "null") as {
        readonly schemaVersion: number;
        readonly language: string;
        readonly families: readonly {
          readonly id: string;
          readonly components: readonly {
            readonly kind: string;
            readonly templateArtifacts?: readonly string[];
            readonly acceptanceArtifacts: readonly string[];
          }[];
        }[];
      };
      expect(capabilityManifest.schemaVersion).toBe(1);
      expect(capabilityManifest.language).toBe(language);
      expect(capabilityManifest.families.map(({ id }) => id)).toEqual(capabilityFamilies);
      for (const family of capabilityManifest.families) {
        expect(family.components.map(({ kind }) => kind)).toEqual([
          "implemented",
          "integration-port"
        ]);
        expect(
          family.components.every(({ acceptanceArtifacts }) => acceptanceArtifacts.length > 0)
        ).toBe(true);
        expect(
          family.components
            .filter(({ kind }) => kind === "integration-port")
            .every(({ templateArtifacts }) => (templateArtifacts?.length ?? 0) > 0)
        ).toBe(true);
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
    for (const [typeScriptPath, javaScriptPath] of [
      ["modules/tooling.ts", "modules/tooling.js"],
      ["modules/tooling.test.ts", "modules/tooling.test.js"],
      ["modules/evaluation.ts", "modules/evaluation.js"],
      ["modules/evaluation.test.ts", "modules/evaluation.test.js"]
    ] as const) {
      const typed = typeScript.find((artifact) => artifact.path.endsWith(typeScriptPath));
      const plain = javaScript.find((artifact) => artifact.path.endsWith(javaScriptPath));
      expect(
        ts.transpileModule(typed?.content ?? "", {
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
        }).outputText
      ).toBe(plain?.content);
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
      const expectedProviderPaths = new Set(
        (providerArtifacts.get(language) ?? []).map((path) => `aiyoke-runtime/${language}/${path}`)
      );
      const renderedProviders = artifacts.filter((artifact) =>
        expectedProviderPaths.has(artifact.path)
      );
      expect(renderedProviders.map((artifact) => artifact.path)).toEqual([
        ...expectedProviderPaths
      ]);
      for (const artifact of renderedProviders) {
        expect(artifact.content).not.toMatch(/process\.env|Deno\.env|\.env\b/);
      }
      if (renderedProviders.length > 0) {
        expect(renderedProviders.map((artifact) => artifact.content).join("\n")).toMatch(
          /SecretResolver|resolveSecret/
        );
      }
    }
  });
});
