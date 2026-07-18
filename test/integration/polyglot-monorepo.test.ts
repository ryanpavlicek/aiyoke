import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionId, type HarnessSpec } from "../../src/core/index.js";
import { AiyokeEngine } from "../../src/engine/index.js";
import { defaultHarnessSpec, stringifyHarnessSpec } from "../../src/infrastructure/config/index.js";

interface WorkspaceCase {
  readonly id: string;
  readonly path: string;
  readonly language: "python" | "typescript" | "javascript" | "rust" | "go";
  readonly framework:
    | "fastapi"
    | "django"
    | "flask"
    | "nextjs"
    | "nestjs"
    | "fastify"
    | "express"
    | "axum"
    | "actix"
    | "chi"
    | "gin"
    | "fiber";
  readonly manifest: string;
  readonly content: string;
  readonly integration: string;
}

const cases: readonly WorkspaceCase[] = [
  {
    id: "python-fastapi",
    path: "services/python/fastapi",
    language: "python",
    framework: "fastapi",
    manifest: "pyproject.toml",
    content: "[project]\ndependencies=['fastapi']\n",
    integration: "fastapi_aiyoke.py"
  },
  {
    id: "python-django",
    path: "services/python/django",
    language: "python",
    framework: "django",
    manifest: "pyproject.toml",
    content: "[project]\ndependencies=['django']\n",
    integration: "django_aiyoke.py"
  },
  {
    id: "python-flask",
    path: "services/python/flask",
    language: "python",
    framework: "flask",
    manifest: "pyproject.toml",
    content: "[project]\ndependencies=['flask']\n",
    integration: "flask_aiyoke.py"
  },
  {
    id: "typescript-next",
    path: "apps/node/next",
    language: "typescript",
    framework: "nextjs",
    manifest: "package.json",
    content: '{"dependencies":{"next":"1.0.0"}}\n',
    integration: "integrations/nextjs.ts"
  },
  {
    id: "typescript-nest",
    path: "apps/node/nest",
    language: "typescript",
    framework: "nestjs",
    manifest: "package.json",
    content: '{"dependencies":{"@nestjs/core":"1.0.0"}}\n',
    integration: "integrations/nestjs.ts"
  },
  {
    id: "typescript-fastify",
    path: "apps/node/fastify",
    language: "typescript",
    framework: "fastify",
    manifest: "package.json",
    content: '{"dependencies":{"fastify":"1.0.0"}}\n',
    integration: "integrations/fastify.ts"
  },
  {
    id: "javascript-express",
    path: "apps/node/express",
    language: "javascript",
    framework: "express",
    manifest: "package.json",
    content: '{"dependencies":{"express":"1.0.0"}}\n',
    integration: "integrations/express.js"
  },
  {
    id: "rust-axum",
    path: "services/rust/axum",
    language: "rust",
    framework: "axum",
    manifest: "Cargo.toml",
    content: "[dependencies]\naxum='1'\n",
    integration: "axum_aiyoke.rs"
  },
  {
    id: "rust-actix",
    path: "services/rust/actix",
    language: "rust",
    framework: "actix",
    manifest: "Cargo.toml",
    content: "[dependencies]\nactix-web='1'\n",
    integration: "actix_aiyoke.rs"
  },
  {
    id: "go-chi",
    path: "services/go/chi",
    language: "go",
    framework: "chi",
    manifest: "go.mod",
    content: "module example/chi\nrequire github.com/go-chi/chi v1.0.0\n",
    integration: "chi_aiyoke.go"
  },
  {
    id: "go-gin",
    path: "services/go/gin",
    language: "go",
    framework: "gin",
    manifest: "go.mod",
    content: "module example/gin\nrequire github.com/gin-gonic/gin v1.0.0\n",
    integration: "gin_aiyoke.go"
  },
  {
    id: "go-fiber",
    path: "services/go/fiber",
    language: "go",
    framework: "fiber",
    manifest: "go.mod",
    content: "module example/fiber\nrequire github.com/gofiber/fiber v1.0.0\n",
    integration: "fiber_aiyoke.go"
  }
];

const temporaryRoots: string[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  );
});

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

function monorepoSpec(): HarnessSpec {
  const defaults = defaultHarnessSpec("polyglot-monorepo");
  return {
    ...defaults,
    composition: {
      kind: "monorepo",
      root: { languages: [], frameworks: [] },
      workspaces: cases.map((item) => ({
        id: extensionId(item.id),
        path: item.path,
        stack: {
          languages: [extensionId(item.language)],
          frameworks: [extensionId(item.framework)]
        }
      }))
    }
  };
}

describe("polyglot monorepo acceptance", () => {
  it(
    "detects and deterministically renders every supported framework family",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aiyoke-polyglot-"));
      temporaryRoots.push(root);
      for (const item of cases) {
        await write(root, `${item.path}/${item.manifest}`, item.content);
        if (item.language === "typescript") {
          await write(root, `${item.path}/tsconfig.json`, "{}\n");
          await write(root, `${item.path}/src/index.ts`, "export {};\n");
        } else if (item.language === "javascript") {
          await write(root, `${item.path}/src/index.js`, "export {};\n");
        } else if (item.language === "python") {
          await write(root, `${item.path}/src/app.py`, "pass\n");
        } else if (item.language === "rust") {
          await write(root, `${item.path}/src/main.rs`, "fn main() {}\n");
        } else {
          await write(root, `${item.path}/main.go`, "package main\nfunc main() {}\n");
        }
      }
      // Deliberately conflicting nested evidence proves enumeration and selection stay explicit.
      await write(
        root,
        "apps/node/next/examples/legacy/package.json",
        '{"dependencies":{"express":"1.0.0","fastify":"1.0.0"}}\n'
      );
      await write(root, "aiyoke.yaml", stringifyHarnessSpec(monorepoSpec()));

      const engine = await AiyokeEngine.open(root);
      const firstDetection = await engine.detect();
      const secondDetection = await engine.detect();
      expect(secondDetection).toEqual(firstDetection);
      const detectedIds = firstDetection.map((item) => item.descriptor.id);
      expect(new Set(detectedIds)).toEqual(
        new Set([
          "python",
          "typescript",
          "javascript",
          "rust",
          "go",
          ...cases.map((item) => item.framework)
        ])
      );

      const firstPlan = await engine.plan();
      const secondPlan = await engine.plan();
      expect(secondPlan).toEqual(firstPlan);
      const plannedPaths = firstPlan.operations.map((operation) =>
        operation.kind === "conflict" ? operation.path : operation.artifact.path
      );
      expect(plannedPaths).toEqual([...plannedPaths].sort());
      expect(firstPlan.operations.some((operation) => operation.kind === "conflict")).toBe(false);
      for (const item of cases) {
        expect(plannedPaths).toContain(
          `${item.path}/aiyoke-runtime/${item.language}/${item.integration}`
        );
      }

      const applied = await engine.apply();
      expect(applied.changedPaths.length).toBeGreaterThan(100);
      const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
      for (const framework of [
        "FastAPI",
        "Django",
        "Flask",
        "Next.js",
        "NestJS",
        "Fastify",
        "Express",
        "Axum",
        "Actix Web",
        "Chi",
        "Gin",
        "Fiber"
      ]) {
        expect(instructions).toContain(framework);
      }
      expect((await engine.check()).filter((finding) => finding.severity === "error")).toEqual([]);
      expect((await engine.apply()).changedPaths).toEqual([]);
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );
});
