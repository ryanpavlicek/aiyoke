#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEntries = [
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.js",
  "package/dist/core/index.d.ts",
  "package/dist/core/index.js",
  "package/dist/extension-sdk/index.d.ts",
  "package/dist/extension-sdk/index.js",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/docs/architecture.md",
  "package/docs/extensions.md",
  "package/package.json"
];
const forbidden = [
  /^package\/(?:src|test|coverage|node_modules|examples)(?:\/|$)/,
  /^package\/(?:\.env(?:\..*)?|AGENTS\.md)$/,
  /(?:^|\/)\.aiyoke(?:\/|$)/
];

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function runPackageManager(manager, arguments_, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "node_modules",
      manager,
      "bin",
      manager === "npm" ? "npm-cli.js" : "pnpm.mjs"
    ),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      manager,
      "bin",
      manager === "npm" ? "npm-cli.js" : "pnpm.mjs"
    )
  ].filter((candidate) => {
    if (typeof candidate !== "string") return false;
    const normalized = candidate.replaceAll("\\", "/");
    return manager === "npm"
      ? normalized.endsWith("/npm/bin/npm-cli.js")
      : /\/pnpm\/bin\/pnpm\.(?:c?js|mjs)$/.test(normalized);
  });
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return run(process.execPath, [candidate, ...arguments_], options);
    } catch {
      // Try the next package-manager location before falling back to its shim.
    }
  }
  return run(command(manager), arguments_, options);
}

function run(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: process.platform === "win32" && executable.endsWith(".cmd"),
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited with code ${code}.\n${stderr}`));
    });
  });
}

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readText = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readText(0, 100);
    const prefix = readText(345, 155);
    const sizeText = readText(124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Package tar has an invalid entry size.");
    const entryPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const contentStart = offset + 512;
    entries.set(entryPath, tar.subarray(contentStart, contentStart + size));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validateArchive(archivePath, archive) {
  if (archive.byteLength > 5 * 1024 * 1024) {
    throw new Error("Packed package exceeds the 5 MiB release limit.");
  }
  const entries = tarEntries(archive);
  for (const required of requiredEntries) {
    if (!entries.has(required)) throw new Error(`Packed package is missing ${required}.`);
  }
  for (const entry of entries.keys()) {
    if (forbidden.some((pattern) => pattern.test(entry))) {
      throw new Error(`Packed package contains forbidden entry ${entry}.`);
    }
  }
  const packageJson = JSON.parse(entries.get("package/package.json").toString("utf8"));
  if (
    packageJson.name !== "aiyoke" ||
    packageJson.private !== false ||
    packageJson.sideEffects !== false ||
    packageJson.engines?.node !== ">=22" ||
    packageJson.bin?.aiyoke !== "./dist/cli.js" ||
    packageJson.exports?.["."]?.import !== "./dist/index.js" ||
    packageJson.exports?.["./extension-sdk"]?.import !== "./dist/extension-sdk/index.js"
  ) {
    throw new Error("Packed package metadata does not match the supported public contract.");
  }
  return { archivePath, packageJson, entryCount: entries.size };
}

async function installSmoke(archivePath, installer) {
  const consumer = await mkdtemp(path.join(tmpdir(), "aiyoke-package-consumer-"));
  try {
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({ name: "aiyoke-package-smoke", private: true, type: "module" }),
      "utf8"
    );
    const installArguments =
      installer === "pnpm"
        ? ["add", "--ignore-scripts", archivePath]
        : ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath];
    await runPackageManager(installer, installArguments, { cwd: consumer, capture: true });
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const api=await import('aiyoke'); const sdk=await import('aiyoke/extension-sdk'); const core=await import('aiyoke/core'); if(typeof api.createAiyoke!=='function'||typeof sdk.runExtensionCompatibility!=='function'||typeof core.extensionId!=='function') process.exit(1);"
      ],
      { cwd: consumer }
    );
    const cli = path.join(consumer, "node_modules", "aiyoke", "dist", "cli.js");
    const help = await run(process.execPath, [cli, "--help"], { cwd: consumer, capture: true });
    if (!help.stdout.includes("aiyoke")) throw new Error("Installed CLI help smoke failed.");
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function validateAndInstall(archivePath) {
  const validation = validateArchive(archivePath, await readFile(archivePath));
  const installer = process.env.AIYOKE_PACKAGE_INSTALLER ?? "npm";
  if (!new Set(["npm", "pnpm"]).has(installer)) {
    throw new Error("AIYOKE_PACKAGE_INSTALLER must be npm or pnpm.");
  }
  await installSmoke(archivePath, installer);
  console.log(
    `Package ${validation.packageJson.version} passed ${validation.entryCount} content checks and ${installer} install smoke.`
  );
}

const providedArchive = process.argv[2];
if (providedArchive !== undefined) {
  await validateAndInstall(path.resolve(providedArchive));
} else {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "aiyoke-package-validation-"));
  try {
    await runPackageManager("pnpm", ["pack", "--pack-destination", temporaryRoot], {
      capture: true,
      env: { ...process.env, npm_config_ignore_scripts: "true" }
    });
    const archives = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error("Expected exactly one packed release artifact.");
    await validateAndInstall(path.join(temporaryRoot, archives[0]));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
