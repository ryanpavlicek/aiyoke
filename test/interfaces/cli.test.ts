import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { parseHarnessSpec, parseSchemaDocument } from "../../src/infrastructure/config/index.js";
import { type ConfigPromptPort, runCli } from "../../src/interfaces/cli/index.js";

const temporaryRoots: string[] = [];

class FakePrompt implements ConfigPromptPort {
  readonly answers: string[];
  closed = false;

  constructor(answers: readonly string[]) {
    this.answers = [...answers];
  }

  async question(): Promise<string> {
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("Fake prompt ran out of answers.");
    return answer;
  }

  close(): void {
    this.closed = true;
  }
}

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

  it("previews and applies schema migrations from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-migrate-"));
    temporaryRoots.push(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init", "--root", root])).toBe(0);
    const current = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    if (current.composition.kind !== "single") throw new Error("default must be single");
    const legacy = stringify({
      schemaVersion: 1,
      project: current.project,
      stack: current.composition.stack,
      targets: current.targets,
      packs: current.packs,
      generation: current.generation
    });
    await writeFile(join(root, "aiyoke.yaml"), legacy, "utf8");

    expect(await runCli(["migrate", "--root", root, "--dry-run"])).toBe(0);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(legacy);
    expect(await runCli(["migrate", "--root", root, "--json"])).toBe(0);
    expect(
      parseSchemaDocument(await readFile(join(root, "aiyoke.yaml"), "utf8")).schemaVersion
    ).toBe(2);
    expect(await runCli(["rollback", "--root", root])).toBe(1);
  });

  it("previews and applies deterministic configuration flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-config-"));
    temporaryRoots.push(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init", "--root", root])).toBe(0);
    const before = await readFile(join(root, "aiyoke.yaml"), "utf8");
    expect(await runCli(["config", "--root", root, "--name", "preview", "--dry-run"])).toBe(0);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(before);

    expect(
      await runCli([
        "config",
        "--root",
        root,
        "--name",
        "configured",
        "--architecture",
        "clean",
        "--languages",
        "go",
        "--frameworks",
        "gin",
        "--targets",
        "codex,openrouter",
        "--packs",
        "engineering"
      ])
    ).toBe(0);
    const spec = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    expect(spec.project).toEqual({ name: "configured", architecture: "clean" });
    expect(spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["go"], frameworks: ["gin"] }
    });
    expect(spec.targets.map((target) => target.adapter)).toEqual(["codex", "openrouter"]);
  });

  it("confirms or cancels TTY-only interactive configuration without partial writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiyoke-cli-interactive-"));
    temporaryRoots.push(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init", "--root", root])).toBe(0);

    const confirmed = new FakePrompt([
      "interactive",
      "hexagonal",
      "python",
      "fastapi",
      "codex,openrouter",
      "engineering",
      "yes"
    ]);
    expect(
      await runCli(["config", "--root", root, "--interactive"], {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: confirmed
      })
    ).toBe(0);
    expect(confirmed.closed).toBe(true);
    const configured = parseHarnessSpec(await readFile(join(root, "aiyoke.yaml"), "utf8"));
    expect(configured.project).toEqual({ name: "interactive", architecture: "hexagonal" });
    const beforeCancel = await readFile(join(root, "aiyoke.yaml"), "utf8");

    const cancelled = new FakePrompt(["cancel"]);
    expect(
      await runCli(["config", "--root", root, "--interactive"], {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: cancelled
      })
    ).toBe(0);
    expect(cancelled.closed).toBe(true);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(beforeCancel);

    const notTty = new FakePrompt([]);
    expect(
      await runCli(["config", "--root", root, "--interactive"], {
        inputIsTTY: false,
        outputIsTTY: true,
        prompt: notTty
      })
    ).toBe(1);
    expect(notTty.closed).toBe(false);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(beforeCancel);

    const invalid = new FakePrompt(["renamed", "not-an-architecture"]);
    expect(
      await runCli(["config", "--root", root, "--interactive"], {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: invalid
      })
    ).toBe(1);
    expect(invalid.closed).toBe(true);
    expect(await readFile(join(root, "aiyoke.yaml"), "utf8")).toBe(beforeCancel);
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
    ["missing migration version", ["migrate", "--to"]],
    ["invalid migration version", ["migrate", "--to", "zero"]],
    ["missing backup path", ["rollback", "--backup"]],
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
