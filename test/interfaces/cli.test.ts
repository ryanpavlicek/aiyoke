import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHarnessSpec } from "../../src/infrastructure/config/index.js";
import { runCli } from "../../src/interfaces/cli/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("CLI initialization", () => {
  it("selects comma-separated target adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-"));
    temporaryRoots.push(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runCli(["init", "--root", root, "--targets", "codex,openrouter", "--json"])).toBe(
      0
    );
    const spec = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    expect(spec.targets.map((target) => target.adapter)).toEqual(["codex", "openrouter"]);
  });

  it("returns structured failures for invalid target options", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init", "--targets", "--json"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--targets requires"));
  });

  it("runs the complete human-readable command lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-lifecycle-"));
    temporaryRoots.push(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runCli(["--help"])).toBe(0);
    expect(
      await runCli([
        "init",
        "--root",
        root,
        "--languages",
        "go",
        "--frameworks",
        "gin",
        "--targets",
        "codex"
      ])
    ).toBe(0);
    expect(await runCli(["init", "--root", root])).toBe(0);
    expect(await runCli(["plan", "--root", root])).toBe(0);
    expect(await runCli(["apply", "--root", root])).toBe(0);
    expect(await runCli(["apply", "--root", root])).toBe(0);
    expect(await runCli(["check", "--root", root])).toBe(0);
    expect(await runCli(["doctor", "--root", root])).toBe(0);
    expect(await runCli(["detect", "--root", root])).toBe(0);
    expect(await runCli(["list", "--root", root, "--json"])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Already synchronized"));

    await writeFile(
      join(root, "AGENTS.md"),
      "<!-- aiyoke:managed:start -->\nmissing end\n",
      "utf8"
    );
    expect(await runCli(["plan", "--root", root])).toBe(1);
    expect(await runCli(["check", "--root", root])).toBe(1);
    expect(await runCli(["apply", "--root", root])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("artifact conflict"));
  });

  it.each([
    ["missing root", ["init", "--root"]],
    ["missing languages", ["init", "--languages"]],
    ["missing frameworks", ["init", "--frameworks"]],
    ["unknown option", ["init", "--unknown"]],
    ["unexpected argument", ["plan", "extra"]],
    ["unknown command", ["unknown-command"]]
  ])("returns failure for %s", async (_name, args) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(args)).toBe(1);
  });

  it("rejects an unknown target initialization profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-unknown-"));
    temporaryRoots.push(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init", "--root", root, "--targets", "unknown-target", "--json"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("built-in initialization profile"));
  });
});
