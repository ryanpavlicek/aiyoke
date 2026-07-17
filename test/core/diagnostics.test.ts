import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AIYOKE_ERROR_CODES } from "../../src/core/index.js";
import { getBuiltinDiagnosticCatalog } from "../../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function typeScriptFilesBelow(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await typeScriptFilesBelow(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : undefined;
}

function literalProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  const property = object.properties.find((candidate) => propertyName(candidate) === name);
  return property !== undefined &&
    ts.isPropertyAssignment(property) &&
    ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}

function sourceFindingCodes(source: string, path: string): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const severity = literalProperty(node, "severity");
      const code = literalProperty(node, "code");
      if (severity !== undefined && code !== undefined) codes.add(code);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...codes];
}

describe("public diagnostic catalog", () => {
  it("is deterministic, unique, complete, and machine-readable", async () => {
    const catalog = await getBuiltinDiagnosticCatalog();
    const keys = catalog.map((entry) => `${entry.channel}:${entry.code}`);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(catalog.every((entry) => entry.summary.length > 0 && entry.remediation.length > 0)).toBe(
      true
    );
    expect(catalog.every((entry) => entry.stability === "stable")).toBe(true);

    const errorCodes = catalog
      .filter((entry) => entry.channel === "error")
      .map((entry) => entry.code)
      .sort();
    expect(errorCodes).toEqual([...AIYOKE_ERROR_CODES, "UNEXPECTED"].sort());
    expect(Object.isFrozen(AIYOKE_ERROR_CODES)).toBe(true);

    const emittedFindingCodes = new Set<string>();
    for (const path of await typeScriptFilesBelow("src")) {
      const source = await readFile(join(repositoryRoot, ...path.split("/")), "utf8");
      for (const code of sourceFindingCodes(source, path)) emittedFindingCodes.add(code);
    }
    const catalogFindingCodes = catalog
      .filter((entry) => entry.channel === "finding")
      .map((entry) => entry.code)
      .sort();
    expect(catalogFindingCodes).toEqual([...emittedFindingCodes].sort());

    const documentation = await readFile(
      join(repositoryRoot, "docs", "errors-and-findings.md"),
      "utf8"
    );
    for (const entry of catalog) expect(documentation).toContain(`\`${entry.code}\``);
  });
});
