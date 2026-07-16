#!/usr/bin/env node

/**
 * Check the dependency direction of the source tree.
 *
 * This intentionally operates on the TypeScript AST instead of regular
 * expressions.  That keeps comments, strings, and dynamic `import()` calls
 * from being mistaken for static dependencies.  The checker is a small,
 * dependency-free policy module from the repository's point of view: the
 * TypeScript compiler is already a development dependency used by the build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const EXTENSION_CATEGORIES = new Set(["targets", "languages", "frameworks", "packs"]);
const compareStable = (left, right) => (left === right ? 0 : left < right ? -1 : 1);

/**
 * Allowed static dependency edges.  A source file may always import a
 * third-party package; these rules only apply when an import resolves into
 * this repository's `src` directory.
 */
export const ALLOWED_IMPORTS = Object.freeze({
  core: new Set(["core"]),
  "extension-sdk": new Set(["core", "extension-sdk"]),
  application: new Set(["core", "extension-sdk", "application"]),
  infrastructure: new Set(["core", "extension-sdk", "application", "infrastructure"]),
  engine: new Set([
    "core",
    "extension-sdk",
    "application",
    "infrastructure",
    "engine",
    "extensions-shared",
    "extensions",
    "extensions-targets",
    "extensions-languages",
    "extensions-frameworks",
    "extensions-packs"
  ]),
  interfaces: new Set([
    "core",
    "extension-sdk",
    "application",
    "infrastructure",
    "engine",
    "interfaces"
  ]),
  "extensions-shared": new Set(["core", "extension-sdk", "extensions-shared"]),
  extensions: new Set(["core", "extension-sdk", "extensions-shared", "extensions"]),
  "extensions-targets": new Set([
    "core",
    "extension-sdk",
    "extensions-shared",
    "extensions-targets"
  ]),
  "extensions-languages": new Set([
    "core",
    "extension-sdk",
    "extensions-shared",
    "extensions-languages"
  ]),
  "extensions-frameworks": new Set([
    "core",
    "extension-sdk",
    "extensions-shared",
    "extensions-frameworks"
  ]),
  "extensions-packs": new Set(["core", "extension-sdk", "extensions-shared", "extensions-packs"]),
  // `src/cli.ts` is a thin executable entry point.  It is allowed to delegate
  // to the CLI interface bootstrap and to the public contracts only.
  cli: new Set(["core", "extension-sdk", "interfaces", "cli"]),
  shared: new Set(["core", "shared"]),
  "public-api": new Set(["core", "extension-sdk", "public-api"])
});

const HEAVY_PUBLIC_API_LAYERS = new Set([
  "application",
  "infrastructure",
  "engine",
  "interfaces",
  "extensions",
  "extensions-shared",
  "extensions-targets",
  "extensions-languages",
  "extensions-frameworks",
  "extensions-packs",
  "cli"
]);

/**
 * @typedef {{file:string, fromLayer:string, importedFile:string, toLayer:string, specifier:string, message:string}} ArchitectureViolation
 */

/**
 * Return all source files under `src`, in deterministic order.
 * @param {string} srcRoot
 * @returns {string[]}
 */
export function findSourceFiles(srcRoot) {
  if (!fs.existsSync(srcRoot)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareStable(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) &&
        !entry.name.endsWith(".d.ts")
      ) {
        result.push(absolute);
      }
    }
  };
  visit(srcRoot);
  return result.sort(compareStable);
}

/**
 * Classify a source file relative to the source root.
 * @param {string} file
 * @param {string} srcRoot
 * @returns {string}
 */
export function classifyLayer(file, srcRoot) {
  const relative = path.relative(srcRoot, file).replaceAll(path.sep, "/");
  const [top, second] = relative.split("/");
  if (relative === "index.ts" || relative === "index.mts") return "public-api";
  if (relative === "cli.ts" || relative === "cli.mts") return "cli";
  if (top === "extensions" && second === "shared") return "extensions-shared";
  if (top === "extensions" && second !== undefined && EXTENSION_CATEGORIES.has(second)) {
    return `extensions-${second}`;
  }
  if (top === "extensions") return "extensions";
  if (top === "core" || top === "extension-sdk" || top === "application") return top;
  if (top === "infrastructure" || top === "engine" || top === "interfaces") return top;
  if (top === "shared") return "shared";
  return top || "unknown";
}

/**
 * Extract static module specifiers from a TypeScript/JavaScript file.
 * Dynamic `import()` is deliberately excluded because the public API and
 * engine use it as the lazy-loading boundary.
 * @param {string} source
 * @param {string} fileName
 * @returns {string[]}
 */
export function extractStaticImports(source, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function resolveImport(specifier, importer, srcRoot) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [];
  const extension = path.extname(base).toLowerCase();
  if (extension) {
    candidates.push(base);
    // TypeScript's NodeNext convention writes `.js` in source imports while
    // the checked-in source remains `.ts`.
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
      for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts"]) {
        candidates.push(`${base.slice(0, -extension.length)}${sourceExtension}`);
      }
    }
  } else {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS)
      candidates.push(path.join(base, `index${extension}`));
  }
  const resolved = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );
  if (resolved === undefined) return undefined;
  const relative = path.relative(srcRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

/**
 * Check all static, repository-local imports.
 * @param {{root?:string, srcDir?:string}} [options]
 * @returns {{ok:boolean, files:string[], violations:ArchitectureViolation[]}}
 */
export function checkArchitecture(options = {}) {
  const root = path.resolve(
    options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  );
  const srcRoot = path.resolve(root, options.srcDir ?? "src");
  const files = findSourceFiles(srcRoot);
  const violations = [];

  for (const file of files) {
    const fromLayer = classifyLayer(file, srcRoot);
    const allowed = ALLOWED_IMPORTS[fromLayer] ?? new Set();
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of extractStaticImports(source, file)) {
      const importedFile = resolveImport(specifier, file, srcRoot);
      if (importedFile === undefined) continue;
      const toLayer = classifyLayer(importedFile, srcRoot);
      const disallowed = !allowed.has(toLayer);
      const publicHeavyImport = fromLayer === "public-api" && HEAVY_PUBLIC_API_LAYERS.has(toLayer);
      if (!disallowed && !publicHeavyImport) continue;
      const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
      const relativeImported = path.relative(root, importedFile).replaceAll(path.sep, "/");
      let message = `${fromLayer} may not statically import ${toLayer}`;
      if (publicHeavyImport) message = "the public API must lazy-load heavy layers";
      violations.push({
        file: relativeFile,
        fromLayer,
        importedFile: relativeImported,
        toLayer,
        specifier,
        message
      });
    }
  }

  violations.sort((a, b) =>
    compareStable(
      `${a.file}\0${a.importedFile}\0${a.specifier}`,
      `${b.file}\0${b.importedFile}\0${b.specifier}`
    )
  );
  return { ok: violations.length === 0, files, violations };
}

export function formatViolations(violations) {
  return violations
    .map(
      (violation) =>
        `- ${violation.file} (${violation.fromLayer}) -> ${violation.importedFile} (${violation.toLayer}): ${violation.message}`
    )
    .join("\n");
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  const result = checkArchitecture();
  if (result.ok) {
    console.log(`Architecture check passed (${result.files.length} source files).`);
  } else {
    console.error(`Architecture check failed with ${result.violations.length} violation(s):`);
    console.error(formatViolations(result.violations));
    process.exitCode = 1;
  }
}
