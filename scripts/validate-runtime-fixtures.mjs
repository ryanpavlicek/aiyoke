#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  if (options.requireEmptyStdout === true && result.stdout.trim().length > 0) {
    throw new Error(`${command} ${args.join(" ")} reported unformatted output.\n${result.stdout}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "aiyoke-runtime-validation-"));
try {
  const engine = await AiyokeEngine.open(root);
  await engine.initialize({
    languages: ["python", "typescript", "javascript", "rust", "go"].map(extensionId),
    frameworks: [],
    targetAdapters: [extensionId("codex"), extensionId("openrouter")]
  });
  await engine.apply();

  const javaScriptDirectory = join(root, "aiyoke-runtime", "javascript");
  const typeScriptDirectory = join(root, "aiyoke-runtime", "typescript");
  const pythonDirectory = join(root, "aiyoke-runtime", "python");
  const goDirectory = join(root, "aiyoke-runtime", "go");
  const rustDirectory = join(root, "aiyoke-runtime", "rust");

  run(process.execPath, ["--check", join(javaScriptDirectory, "runtime.js")]);
  run(process.execPath, ["--check", join(javaScriptDirectory, "modules", "tooling.js")]);
  run(process.execPath, ["--check", join(javaScriptDirectory, "modules", "evaluation.js")]);
  run(process.execPath, ["--check", join(javaScriptDirectory, "providers", "responses.js")]);
  run(process.execPath, ["--test", join(javaScriptDirectory, "runtime.test.js")]);
  run(process.execPath, [
    "--test",
    join(javaScriptDirectory, "modules", "tooling.test.js"),
    join(javaScriptDirectory, "modules", "evaluation.test.js")
  ]);
  run(process.execPath, ["--test", join(javaScriptDirectory, "providers", "responses.test.js")]);
  run(process.execPath, [
    resolve("node_modules", "typescript", "bin", "tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--types",
    "node",
    "--typeRoots",
    resolve("node_modules", "@types"),
    "--skipLibCheck",
    join(typeScriptDirectory, "runtime.ts"),
    join(typeScriptDirectory, "runtime.test.ts"),
    join(typeScriptDirectory, "modules", "tooling.ts"),
    join(typeScriptDirectory, "modules", "tooling.test.ts"),
    join(typeScriptDirectory, "modules", "evaluation.ts"),
    join(typeScriptDirectory, "modules", "evaluation.test.ts"),
    join(typeScriptDirectory, "providers", "responses.ts"),
    join(typeScriptDirectory, "providers", "responses.test.ts")
  ]);
  run(process.execPath, [
    resolve("node_modules", "tsx", "dist", "cli.mjs"),
    "--test",
    join(typeScriptDirectory, "runtime.test.ts"),
    join(typeScriptDirectory, "modules", "tooling.test.ts"),
    join(typeScriptDirectory, "modules", "evaluation.test.ts"),
    join(typeScriptDirectory, "providers", "responses.test.ts")
  ]);
  const python = process.platform === "win32" ? "python" : "python3";
  run(python, [
    "-m",
    "py_compile",
    join(pythonDirectory, "runtime.py"),
    join(pythonDirectory, "test_runtime.py"),
    join(pythonDirectory, "modules", "tooling.py"),
    join(pythonDirectory, "modules", "test_tooling.py"),
    join(pythonDirectory, "modules", "evaluation.py"),
    join(pythonDirectory, "modules", "test_evaluation.py"),
    join(pythonDirectory, "providers", "responses.py"),
    join(pythonDirectory, "providers", "test_responses.py")
  ]);
  run(python, ["-m", "unittest", "discover", "-s", pythonDirectory, "-p", "test_runtime.py"]);
  run(python, ["-m", "unittest", "discover", "-s", pythonDirectory, "-p", "test_tooling.py"]);
  run(python, ["-m", "unittest", "discover", "-s", pythonDirectory, "-p", "test_evaluation.py"]);
  run(python, ["-m", "unittest", "discover", "-s", pythonDirectory, "-p", "test_responses.py"]);
  run("go", [
    "test",
    join(goDirectory, "runtime.go"),
    join(goDirectory, "runtime_test.go"),
    join(goDirectory, "tooling.go"),
    join(goDirectory, "tooling_test.go"),
    join(goDirectory, "evaluation.go"),
    join(goDirectory, "evaluation_test.go"),
    join(goDirectory, "responses_provider.go"),
    join(goDirectory, "responses_provider_test.go")
  ]);
  run("gofmt", ["-d", join(goDirectory, "runtime.go"), join(goDirectory, "runtime_test.go")], {
    requireEmptyStdout: true
  });
  run(
    "gofmt",
    [
      "-d",
      join(goDirectory, "tooling.go"),
      join(goDirectory, "tooling_test.go"),
      join(goDirectory, "evaluation.go"),
      join(goDirectory, "evaluation_test.go"),
      join(goDirectory, "responses_provider.go"),
      join(goDirectory, "responses_provider_test.go")
    ],
    { requireEmptyStdout: true }
  );
  run("rustfmt", [
    "--edition",
    "2021",
    "--check",
    join(rustDirectory, "runtime.rs"),
    join(rustDirectory, "runtime_test.rs"),
    join(rustDirectory, "responses_provider.rs"),
    join(rustDirectory, "responses_provider_test.rs")
  ]);
  run("rustc", [
    "--edition",
    "2021",
    "--test",
    "--out-dir",
    rustDirectory,
    join(rustDirectory, "runtime_test.rs")
  ]);
  run(join(rustDirectory, process.platform === "win32" ? "runtime_test.exe" : "runtime_test"), []);
  run("rustc", [
    "--edition",
    "2021",
    "--test",
    "--out-dir",
    rustDirectory,
    join(rustDirectory, "responses_provider_test.rs")
  ]);
  run(
    join(
      rustDirectory,
      process.platform === "win32" ? "responses_provider_test.exe" : "responses_provider_test"
    ),
    []
  );

  process.stdout.write("All generated runtime templates passed their native conformance suites.\n");
} catch (error) {
  process.stderr.write(`Preserved failed runtime fixture at ${root}.\n`);
  throw error;
}

if (process.env.AIYOKE_KEEP_RUNTIME_FIXTURE === "1") {
  process.stdout.write(`Preserved runtime fixture at ${root}.\n`);
} else {
  const resolved = resolve(root);
  const temporary = resolve(tmpdir());
  if (!resolved.startsWith(`${temporary}\\`) && !resolved.startsWith(`${temporary}/`)) {
    throw new Error(`Refusing to remove runtime fixture outside ${temporary}.`);
  }
  if (!basename(resolved).startsWith("aiyoke-runtime-validation-")) {
    throw new Error(`Refusing to remove unexpected runtime fixture ${resolved}.`);
  }
  await rm(resolved, { recursive: true, force: true });
}
