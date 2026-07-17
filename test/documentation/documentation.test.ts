import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_HELP, runCli } from "../../src/interfaces/cli/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const exampleRoot = join(repositoryRoot, "examples", "quickstart-nextjs");
const temporaryRoots: string[] = [];

async function copyStarter(target: string): Promise<void> {
  for (const path of ["package.json", "tsconfig.json", "next.config.mjs", "app/page.tsx"]) {
    const destination = join(target, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(exampleRoot, "starter", ...path.split("/")), destination);
  }
}

async function filesBelow(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll(sep, "/"));
    }
  };
  await visit(root);
  return files.sort();
}

function publicExportNames(source: string, path: string): readonly string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      }
      continue;
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text);
    }
  }
  return [...names].sort();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("executable documentation", () => {
  it("runs the checked-in Next.js quickstart through drift recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-doc-quickstart-"));
    temporaryRoots.push(root);
    await copyStarter(root);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));

    expect(await runCli(["detect", "--root", root])).toBe(0);
    expect(logs.join("\n")).toContain("typescript");
    expect(logs.join("\n")).toContain("nextjs");
    logs.length = 0;

    expect(
      await runCli([
        "init",
        "--root",
        root,
        "--languages",
        "typescript",
        "--frameworks",
        "nextjs",
        "--targets",
        "claude-code,codex,openrouter"
      ])
    ).toBe(0);
    expect(await runCli(["plan", "--root", root])).toBe(0);
    await expect(access(join(root, ".aiyoke", "lock.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    logs.length = 0;
    expect(await runCli(["apply", "--root", root])).toBe(0);
    const expected = JSON.parse(
      await readFile(join(exampleRoot, "expected-generated-paths.json"), "utf8")
    ) as unknown;
    expect(expected).toSatisfy(
      (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string")
    );
    const expectedPaths = expected as string[];
    const starterPaths = new Set([
      "aiyoke.yaml",
      "app/page.tsx",
      "next.config.mjs",
      "package.json",
      "tsconfig.json"
    ]);
    expect((await filesBelow(root)).filter((path) => !starterPaths.has(path))).toEqual(
      expectedPaths
    );
    expect(logs.join("\n")).toContain(`Applied ${expectedPaths.length} change(s)`);

    expect(await runCli(["check", "--root", root])).toBe(0);
    logs.length = 0;
    expect(await runCli(["apply", "--root", root])).toBe(0);
    expect(logs.join("\n")).toContain("Already synchronized; no changes made.");

    await writeFile(join(root, ".openrouter", "config.json"), "drift\n", "utf8");
    logs.length = 0;
    expect(await runCli(["check", "--root", root])).toBe(1);
    expect(logs.join("\n")).toContain("GENERATED_DRIFT");
    expect(await runCli(["plan", "--root", root])).toBe(0);
    expect(await runCli(["apply", "--root", root])).toBe(0);
    expect(await runCli(["check", "--root", root])).toBe(0);
    expect(await readFile(join(root, ".openrouter", "config.json"), "utf8")).toContain(
      "OPENROUTER_API_KEY"
    );
  });

  it("keeps CLI help, reference commands, flags, and the pinned example tree aligned", async () => {
    const cliReference = await readFile(join(repositoryRoot, "docs", "cli.md"), "utf8");
    const quickstart = await readFile(join(exampleRoot, "README.md"), "utf8");
    const commands = [
      "init",
      "config",
      "detect",
      "list",
      "plan",
      "apply",
      "check",
      "doctor",
      "migrate",
      "rollback"
    ];
    for (const command of commands) {
      expect(CLI_HELP).toContain(`aiyoke ${command}`);
      expect(cliReference).toContain(`\`${command}\``);
    }
    const helpOptions = new Set(CLI_HELP.match(/--[a-z-]+/g) ?? []);
    for (const option of helpOptions) expect(cliReference).toContain(option);
    expect(CLI_HELP).toContain("Preview config, migration, or rollback output without writing");

    const expected = JSON.parse(
      await readFile(join(exampleRoot, "expected-generated-paths.json"), "utf8")
    ) as string[];
    for (const path of expected) expect(quickstart).toContain(path);
    for (const command of ["detect", "init", "plan", "apply", "check"]) {
      expect(quickstart).toContain(`npx aiyoke ${command}`);
    }
  });

  it("documents every supported package entry point and directly exported symbol", async () => {
    const apiReference = await readFile(join(repositoryRoot, "docs", "api.md"), "utf8");
    const packageManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8")
    ) as { readonly exports?: Readonly<Record<string, unknown>> };
    expect(Object.keys(packageManifest.exports ?? {}).sort()).toEqual([
      ".",
      "./core",
      "./extension-sdk"
    ]);
    for (const entryPoint of ["aiyoke", "aiyoke/core", "aiyoke/extension-sdk"]) {
      expect(apiReference).toContain(`\`${entryPoint}\``);
    }

    for (const sourcePath of ["src/index.ts", "src/core/index.ts", "src/extension-sdk/index.ts"]) {
      const source = await readFile(join(repositoryRoot, ...sourcePath.split("/")), "utf8");
      for (const name of publicExportNames(source, sourcePath)) {
        expect(apiReference, `${sourcePath} export ${name} is undocumented`).toContain(name);
      }
    }
  });
});
