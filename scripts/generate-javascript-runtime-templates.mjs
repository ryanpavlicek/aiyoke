#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { typescriptRuntime } from "../dist/extensions/runtimes/typescript.js";
import { defaultHarnessSpec } from "../dist/infrastructure/config/index.js";

const write = process.argv.includes("--write");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true
    }
  }).outputText;
}

function templateLiteral(source) {
  return `\`${source.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
}

function artifact(sourceArtifacts, path) {
  const selected = sourceArtifacts.find((candidate) => candidate.path.endsWith(`/${path}`));
  if (selected === undefined) throw new Error(`TypeScript runtime artifact ${path} is missing.`);
  return selected.content;
}

function generatedDefinitions(artifacts, definitions) {
  return definitions.map((definition) => ({
    ...definition,
    source: transpile(artifact(artifacts, definition.typedPath))
  }));
}

function renderArray(name, typeName, entries) {
  return `import type { ${typeName} } from "../shared.js";\n\nexport const ${name}: readonly ${typeName}[] = [\n${entries
    .map(
      (entry) =>
        `  {\n${Object.entries(entry)
          .filter(([key]) => key !== "source" && key !== "typedPath")
          .map(([key, value]) => `    ${key}: ${JSON.stringify(value)},`)
          .join("\n")}\n    source: ${templateLiteral(entry.source)}\n  }`
    )
    .join(",\n")}\n];\n`;
}

function renderModules(artifacts) {
  const modules = [
    {
      id: "tooling",
      description: "Registered, guarded, approval-aware tool execution.",
      paths: ["modules/tooling.ts", "modules/tooling.test.ts"]
    },
    {
      id: "evaluation",
      description: "Versioned offline and sampled-online evaluation runner.",
      paths: ["modules/evaluation.ts", "modules/evaluation.test.ts"]
    }
  ];
  return `import type { RuntimeModuleDefinition } from "../shared.js";\n\nexport const javaScriptRuntimeModules: readonly RuntimeModuleDefinition[] = [\n${modules
    .map(
      (module) =>
        `  {\n    id: ${JSON.stringify(module.id)},\n    description: ${JSON.stringify(
          module.description
        )},\n    artifacts: [\n${module.paths
          .map(
            (path) => `      {
        path: ${JSON.stringify(path.replace(/\.ts$/u, ".js"))},
        source: ${templateLiteral(transpile(artifact(artifacts, path)))}
      }`
          )
          .join(",\n")}\n    ]\n  }`
    )
    .join(",\n")}\n];\n`;
}

function renderProviders(artifacts) {
  const definitions = generatedDefinitions(artifacts, [
    { path: "providers/responses.js", typedPath: "providers/responses.ts" },
    { path: "providers/responses.test.js", typedPath: "providers/responses.test.ts" }
  ]);
  return `import type { ProviderIntegrationDefinition } from "../shared.js";\n\nexport const javaScriptProviders: readonly ProviderIntegrationDefinition[] = [\n  {\n    targets: ["openrouter", "xai-api"],\n    artifacts: [\n${definitions
    .map(
      ({ path, source }) => `      {
        path: ${JSON.stringify(path)},
        source: ${templateLiteral(source)}
      }`
    )
    .join(",\n")}\n    ]\n  }\n];\n`;
}

const spec = {
  ...defaultHarnessSpec("javascript-template-generation"),
  composition: {
    kind: "single",
    stack: {
      languages: ["typescript"],
      frameworks: ["nextjs", "nestjs", "fastify", "express"]
    }
  },
  targets: [
    {
      kind: "inference-gateway",
      adapter: "openrouter",
      routing: { kind: "fixed", model: "test/model" },
      settings: {}
    }
  ]
};
if (spec.runtime.kind !== "enabled" || spec.composition.kind !== "single") {
  throw new Error("Default runtime specification shape changed.");
}
const artifacts = await typescriptRuntime.render({
  spec,
  runtime: spec.runtime,
  scope: { kind: "project", stack: spec.composition.stack },
  workspace: {
    root: "/workspace",
    files: [],
    read: async () => undefined,
    exists: async () => false
  }
});

const outputs = new Map();
outputs.set(
  "src/extensions/runtimes/javascript.ts",
  `import { javaScriptIntegrations } from "./integrations/javascript.js";\nimport { javaScriptRuntimeModules } from "./modules/javascript.js";\nimport { javascriptPolicyArtifact } from "./policy.js";\nimport { javaScriptProviders } from "./providers/javascript.js";\nimport { createRuntimeTemplate, runtimeLoader } from "./shared.js";\n\nconst SOURCE = ${templateLiteral(
    transpile(artifact(artifacts, "runtime.ts"))
  )};\n\nconst TEST_SOURCE = ${templateLiteral(
    transpile(artifact(artifacts, "runtime.test.ts"))
  )};\n\nexport const javascriptRuntime = createRuntimeTemplate({\n  id: "javascript-runtime",\n  language: "javascript",\n  displayName: "JavaScript",\n  fileName: "runtime.js",\n  source: SOURCE,\n  testFileName: "runtime.test.js",\n  testSource: TEST_SOURCE,\n  policyArtifact: javascriptPolicyArtifact,\n  modules: javaScriptRuntimeModules,\n  integrations: javaScriptIntegrations,\n  providers: javaScriptProviders\n});\n\nexport function createJavaScriptRuntimeLoader() {\n  return runtimeLoader(javascriptRuntime);\n}\n\nexport const javascriptRuntimeLoader = createJavaScriptRuntimeLoader();\n`
);
outputs.set("src/extensions/runtimes/modules/javascript.ts", renderModules(artifacts));
outputs.set("src/extensions/runtimes/providers/javascript.ts", renderProviders(artifacts));
outputs.set(
  "src/extensions/runtimes/integrations/javascript.ts",
  renderArray(
    "javaScriptIntegrations",
    "FrameworkIntegrationDefinition",
    generatedDefinitions(artifacts, [
      { framework: "nextjs", path: "integrations/nextjs.js", typedPath: "integrations/nextjs.ts" },
      {
        framework: "fastify",
        path: "integrations/fastify.js",
        typedPath: "integrations/fastify.ts"
      },
      {
        framework: "express",
        path: "integrations/express.js",
        typedPath: "integrations/express.ts"
      }
    ])
  )
);

const stale = [];
for (const [path, content] of outputs) {
  const absolute = resolve(path);
  const current = await readFile(absolute, "utf8");
  if (current === content) continue;
  if (write) {
    await writeFile(absolute, content, "utf8");
  } else {
    stale.push(path);
  }
}
if (stale.length > 0) {
  throw new Error(
    `Generated JavaScript runtime templates are stale: ${stale.join(", ")}. Run pnpm generate:runtime-js.`
  );
}
process.stdout.write(
  write
    ? "Generated JavaScript runtime templates from the TypeScript reference.\n"
    : "Generated JavaScript runtime templates match the TypeScript reference.\n"
);
