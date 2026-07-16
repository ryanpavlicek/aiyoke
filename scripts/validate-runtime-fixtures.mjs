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
    targetAdapters: [extensionId("codex")]
  });
  await engine.apply();

  const javaScriptDirectory = join(root, "aiyoke-runtime", "javascript");
  const typeScriptDirectory = join(root, "aiyoke-runtime", "typescript");
  const pythonDirectory = join(root, "aiyoke-runtime", "python");
  const goDirectory = join(root, "aiyoke-runtime", "go");
  const rustDirectory = join(root, "aiyoke-runtime", "rust");

  run(process.execPath, ["--check", join(javaScriptDirectory, "runtime.js")]);
  run(process.execPath, ["--test", join(javaScriptDirectory, "runtime.test.js")]);
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
    join(typeScriptDirectory, "runtime.test.ts")
  ]);
  run(process.execPath, [
    resolve("node_modules", "tsx", "dist", "cli.mjs"),
    "--test",
    join(typeScriptDirectory, "runtime.test.ts")
  ]);
  const python = process.platform === "win32" ? "python" : "python3";
  run(python, [
    "-m",
    "py_compile",
    join(pythonDirectory, "runtime.py"),
    join(pythonDirectory, "test_runtime.py")
  ]);
  run(python, ["-m", "unittest", "discover", "-s", pythonDirectory, "-p", "test_runtime.py"]);
  run("go", ["test", join(goDirectory, "runtime.go"), join(goDirectory, "runtime_test.go")]);
  run("gofmt", ["-d", join(goDirectory, "runtime.go"), join(goDirectory, "runtime_test.go")], {
    requireEmptyStdout: true
  });
  run("rustc", [
    "--edition",
    "2021",
    "--test",
    "--out-dir",
    rustDirectory,
    join(rustDirectory, "runtime_test.rs")
  ]);
  run(join(rustDirectory, process.platform === "win32" ? "runtime_test.exe" : "runtime_test"), []);

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
