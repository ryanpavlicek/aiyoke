import {
  AiyokeError,
  extensionId,
  type HarnessPlan,
  type VerificationFinding
} from "../../core/index.js";

interface CliOptions {
  readonly command: string;
  readonly root: string;
  readonly json: boolean;
  readonly force: boolean;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly targets?: readonly string[];
}

const HELP = `aiyoke — deterministic AI harness compiler

Usage:
  aiyoke init [--languages python,typescript] [--frameworks fastapi] [--targets claude-code,codex] [--force]
  aiyoke plan
  aiyoke apply
  aiyoke check
  aiyoke doctor
  aiyoke detect
  aiyoke list

Global options:
  --root <path>    Workspace root (default: current directory)
  --json           Emit machine-readable JSON
  --help           Show this help
`;

function splitList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionValue(args: readonly string[], index: number, message: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new AiyokeError("INVALID_SPEC", message);
  }
  return value;
}

function parseArguments(args: readonly string[]): CliOptions {
  let command = "help";
  let root = process.cwd();
  let json = false;
  let force = false;
  let languages: readonly string[] | undefined;
  let frameworks: readonly string[] | undefined;
  let targets: readonly string[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") command = "help";
    else if (argument === "--json") json = true;
    else if (argument === "--force") force = true;
    else if (argument === "--root") {
      const value = optionValue(args, index, "--root requires a path.");
      root = value;
      index += 1;
    } else if (argument === "--languages") {
      const value = optionValue(args, index, "--languages requires a comma-separated list.");
      languages = splitList(value);
      index += 1;
    } else if (argument === "--frameworks") {
      const value = optionValue(args, index, "--frameworks requires a comma-separated list.");
      frameworks = splitList(value);
      index += 1;
    } else if (argument === "--targets") {
      const value = optionValue(args, index, "--targets requires a comma-separated list.");
      targets = splitList(value);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new AiyokeError("INVALID_SPEC", `Unknown option ${argument}.`);
    } else if (command === "help") command = argument;
    else throw new AiyokeError("INVALID_SPEC", `Unexpected argument ${argument}.`);
  }

  const optional = {
    ...(languages === undefined ? {} : { languages }),
    ...(frameworks === undefined ? {} : { frameworks }),
    ...(targets === undefined ? {} : { targets })
  };
  return { command, root, json, force, ...optional };
}

function emit(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, undefined, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, undefined, 2));
}

function planText(plan: HarnessPlan): string {
  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0 };
  const lines: string[] = [];
  for (const operation of plan.operations) {
    counts[operation.kind] += 1;
    const path = operation.kind === "conflict" ? operation.path : operation.artifact.path;
    lines.push(`${operation.kind.padEnd(9)} ${path}`);
  }
  return [
    ...lines,
    "",
    `${counts.create} create, ${counts.update} update, ${counts.unchanged} unchanged, ${counts.conflict} conflict`,
    `fingerprint ${plan.fingerprint}`
  ].join("\n");
}

function findingsText(findings: readonly VerificationFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map(
      (finding) =>
        `${finding.severity.toUpperCase().padEnd(7)} ${finding.code}${finding.path === undefined ? "" : ` ${finding.path}`} — ${finding.message}`
    )
    .join("\n");
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  let options: CliOptions | undefined;
  try {
    options = parseArguments(args);
    if (options.command === "help") {
      emit(HELP, false);
      return 0;
    }

    const { AiyokeEngine } = await import("../../engine/index.js");
    const engine = await AiyokeEngine.open(options.root);
    if (options.command === "init") {
      const result = await engine.initialize({
        force: options.force,
        ...(options.languages === undefined
          ? {}
          : { languages: options.languages.map(extensionId) }),
        ...(options.frameworks === undefined
          ? {}
          : { frameworks: options.frameworks.map(extensionId) }),
        ...(options.targets === undefined
          ? {}
          : { targetAdapters: options.targets.map(extensionId) })
      });
      emit(
        options.json
          ? result
          : result.created
            ? `Created ${result.path}.`
            : `${result.path} already exists; no changes made.`,
        options.json
      );
      return 0;
    }
    if (options.command === "plan") {
      const plan = await engine.plan();
      emit(options.json ? plan : planText(plan), options.json);
      return plan.operations.some((operation) => operation.kind === "conflict") ? 1 : 0;
    }
    if (options.command === "apply") {
      const result = await engine.apply();
      emit(
        options.json
          ? result
          : result.changedPaths.length === 0
            ? "Already synchronized; no changes made."
            : `Applied ${result.changedPaths.length} change(s):\n${result.changedPaths.join("\n")}`,
        options.json
      );
      return 0;
    }
    if (options.command === "check" || options.command === "doctor") {
      const findings = options.command === "check" ? await engine.check() : await engine.doctor();
      emit(options.json ? findings : findingsText(findings), options.json);
      return findings.some((finding) => finding.severity === "error") ? 1 : 0;
    }
    if (options.command === "detect") {
      const detected = await engine.detect();
      emit(
        options.json
          ? detected
          : detected
              .map(
                (item) =>
                  `${item.descriptor.kind.padEnd(9)} ${item.descriptor.id.padEnd(12)} ${item.detection.confidence.toFixed(2)} ${item.detection.reasons.join(", ")}`
              )
              .join("\n") || "No languages or frameworks detected.",
        options.json
      );
      return 0;
    }
    if (options.command === "list") {
      const extensions = engine.listExtensions();
      emit(
        options.json
          ? extensions
          : extensions
              .map(
                (descriptor) =>
                  `${descriptor.kind.padEnd(9)} ${descriptor.id.padEnd(16)} ${descriptor.displayName}`
              )
              .join("\n"),
        options.json
      );
      return 0;
    }
    throw new AiyokeError("INVALID_SPEC", `Unknown command ${options.command}.`);
  } catch (error) {
    const json = options?.json ?? args.includes("--json");
    const payload =
      error instanceof AiyokeError
        ? { error: { code: error.code, message: error.message, details: error.details } }
        : {
            error: {
              code: "UNEXPECTED",
              message: error instanceof Error ? error.message : String(error)
            }
          };
    if (json) console.error(JSON.stringify(payload, undefined, 2));
    else console.error(`aiyoke: ${payload.error.message}`);
    return 1;
  }
}
