#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { extensionId } from "../dist/core/index.js";
import { AiyokeEngine } from "../dist/engine/index.js";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: false
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}).\n${output}`);
  }
}

function runPnpm(args, options) {
  const executable = process.env.npm_execpath;
  if (executable !== undefined && executable.length > 0) {
    run(process.execPath, [executable, ...args], options);
    return;
  }
  run("pnpm", args, options);
}

async function generate(root, name, language, frameworks) {
  const fixture = join(root, name);
  await mkdir(fixture, { recursive: true });
  const engine = await AiyokeEngine.open(fixture);
  await engine.initialize({
    languages: [extensionId(language)],
    frameworks: frameworks.map(extensionId),
    targetAdapters: [extensionId("codex")]
  });
  await engine.apply();
  return join(fixture, "aiyoke-runtime", language);
}

const root = await mkdtemp(join(tmpdir(), "aiyoke-framework-validation-"));
const behaviorFixture = (name) => new URL(`./fixtures/frameworks/${name}`, import.meta.url);
try {
  const typeScript = await generate(root, "typescript", "typescript", [
    "nextjs",
    "nestjs",
    "fastify",
    "express"
  ]);
  const javaScript = await generate(root, "javascript", "javascript", [
    "nextjs",
    "fastify",
    "express"
  ]);
  const python = await generate(root, "python", "python", ["fastapi", "django", "flask"]);
  const go = await generate(root, "go", "go", ["chi", "gin", "fiber"]);
  const rust = await generate(root, "rust", "rust", ["axum", "actix"]);

  const nodeRoot = root;
  await writeFile(
    join(nodeRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "aiyoke-framework-fixture",
        private: true,
        type: "module",
        dependencies: {
          "@nestjs/common": "11.1.28",
          "@types/express": "5.0.6",
          express: "5.2.1",
          fastify: "5.10.0",
          next: "16.2.10",
          react: "19.2.7",
          "react-dom": "19.2.7",
          "reflect-metadata": "0.2.2",
          rxjs: "7.8.2"
        }
      },
      undefined,
      2
    )}\n`,
    "utf8"
  );
  runPnpm(["install", "--ignore-workspace", "--ignore-scripts", "--frozen-lockfile=false"], {
    cwd: nodeRoot
  });
  run(process.execPath, [
    resolve("node_modules", "typescript", "bin", "tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--lib",
    "ES2023,DOM",
    "--skipLibCheck",
    join(typeScript, "runtime.ts"),
    join(typeScript, "integrations", "nextjs.ts"),
    join(typeScript, "integrations", "nestjs.ts"),
    join(typeScript, "integrations", "fastify.ts"),
    join(typeScript, "integrations", "express.ts")
  ]);
  for (const framework of ["nextjs", "fastify", "express"]) {
    run(process.execPath, ["--check", join(javaScript, "integrations", `${framework}.js`)]);
  }
  const typeScriptBehavior = join(typeScript, "framework_behavior.mts");
  await writeFile(
    typeScriptBehavior,
    await readFile(behaviorFixture("typescript-behavior.mts"), "utf8"),
    "utf8"
  );
  run(process.execPath, [resolve("node_modules", "tsx", "dist", "cli.mjs"), typeScriptBehavior], {
    cwd: typeScript
  });
  const javaScriptBehavior = join(javaScript, "framework_behavior.mjs");
  await writeFile(
    javaScriptBehavior,
    await readFile(behaviorFixture("javascript-behavior.mjs"), "utf8"),
    "utf8"
  );
  run(process.execPath, [javaScriptBehavior], { cwd: javaScript });

  const pythonDependencies = join(root, "python-dependencies");
  const pythonExecutable = process.platform === "win32" ? "python" : "python3";
  run(pythonExecutable, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--target",
    pythonDependencies,
    "fastapi==0.139.2",
    "django==6.0.7",
    "flask==3.1.3"
  ]);
  run(pythonExecutable, ["-c", "import fastapi_aiyoke, django_aiyoke, flask_aiyoke"], {
    cwd: python,
    env: { PYTHONPATH: [pythonDependencies, python].join(delimiter) }
  });
  const pythonBehavior = join(python, "framework_behavior.py");
  await writeFile(
    pythonBehavior,
    await readFile(behaviorFixture("python_behavior.py"), "utf8"),
    "utf8"
  );
  run(pythonExecutable, [pythonBehavior], {
    cwd: python,
    env: { PYTHONPATH: [pythonDependencies, python].join(delimiter) }
  });

  await writeFile(
    join(go, "go.mod"),
    `module aiyoke_framework_fixture

go 1.26

require (
	github.com/gin-gonic/gin v1.12.0
	github.com/go-chi/chi/v5 v5.3.1
	github.com/gofiber/fiber/v3 v3.4.0
)
`,
    "utf8"
  );
  await writeFile(
    join(go, "framework_behavior_test.go"),
    await readFile(behaviorFixture("go_behavior_test.go"), "utf8"),
    "utf8"
  );
  run("gofmt", [
    "-w",
    join(go, "runtime.go"),
    join(go, "chi_aiyoke.go"),
    join(go, "gin_aiyoke.go"),
    join(go, "fiber_aiyoke.go"),
    join(go, "framework_behavior_test.go")
  ]);
  run("go", ["mod", "tidy"], { cwd: go });
  run("go", ["test", "./..."], { cwd: go });

  await writeFile(
    join(rust, "Cargo.toml"),
    `[package]
name = "aiyoke-framework-fixture"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
actix-web = "=4.14.0"
axum = "=0.8.9"
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
tokio = { version = "=1.52.4", features = ["rt-multi-thread", "macros"] }

[lib]
path = "lib.rs"
`,
    "utf8"
  );
  await writeFile(
    join(rust, "lib.rs"),
    `pub mod runtime;
pub mod actix_aiyoke;
pub mod axum_aiyoke;
#[cfg(test)]
mod framework_behavior;
`,
    "utf8"
  );
  await writeFile(
    join(rust, "framework_behavior.rs"),
    await readFile(behaviorFixture("rust_behavior.rs"), "utf8"),
    "utf8"
  );
  run("cargo", ["generate-lockfile"], { cwd: rust });
  run("cargo", ["fmt", "--check"], { cwd: rust });
  run("cargo", ["test", "--lib", "--locked"], { cwd: rust });

  process.stdout.write(
    "All generated framework runtime adapters passed real dependency and request-behavior checks.\n"
  );
} catch (error) {
  process.stderr.write(`Preserved failed framework fixture at ${root}.\n`);
  throw error;
}

if (process.env.AIYOKE_KEEP_FRAMEWORK_FIXTURE === "1") {
  process.stdout.write(`Preserved framework fixture at ${root}.\n`);
} else {
  const resolved = resolve(root);
  const temporary = resolve(tmpdir());
  if (!resolved.startsWith(`${temporary}\\`) && !resolved.startsWith(`${temporary}/`)) {
    throw new Error(`Refusing to remove framework fixture outside ${temporary}.`);
  }
  if (!basename(resolved).startsWith("aiyoke-framework-validation-")) {
    throw new Error(`Refusing to remove unexpected framework fixture ${resolved}.`);
  }
  await rm(resolved, { recursive: true, force: true });
}
