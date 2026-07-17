import {
  AiyokeError,
  extensionId,
  type HarnessPlan,
  type ProjectArchitecture,
  type VerificationFinding
} from "../../core/index.js";
import {
  type ConfigPromptPort,
  collectInteractiveConfiguration,
  createNodeConfigPrompt
} from "./interactive-config.js";

interface CliOptions {
  readonly command: string;
  readonly root: string;
  readonly json: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly allowDowngrade: boolean;
  readonly interactive: boolean;
  readonly preset?: string;
  readonly name?: string;
  readonly architecture?: ProjectArchitecture;
  readonly targetVersion?: number;
  readonly backup?: string;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly targets?: readonly string[];
  readonly packs?: readonly string[];
}

export interface CliRuntime {
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly prompt?: ConfigPromptPort;
}

export const CLI_HELP = `aiyoke — deterministic AI harness compiler

Usage:
  aiyoke init [--preset simple] [--languages python,typescript] [--frameworks fastapi] [--targets claude-code,codex] [--force]
  aiyoke plan
  aiyoke apply
  aiyoke check
  aiyoke doctor
  aiyoke detect
  aiyoke list
  aiyoke config [--name <name>] [--architecture layered] [--languages ...] [--frameworks ...] [--targets ...] [--packs ...]
  aiyoke config --interactive
  aiyoke migrate [--to <version>] [--dry-run] [--allow-downgrade]
  aiyoke rollback --backup <path> [--dry-run]

Global options:
  --root <path>    Workspace root (default: current directory)
  --json           Emit machine-readable JSON
  --dry-run        Preview config, migration, or rollback output without writing
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

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a positive integer.`);
  }
  return parsed;
}

function architecture(value: string): ProjectArchitecture {
  if (value === "layered" || value === "hexagonal" || value === "clean" || value === "custom") {
    return value;
  }
  throw new AiyokeError(
    "INVALID_SPEC",
    "--architecture must be layered, hexagonal, clean, or custom."
  );
}

function parseArguments(args: readonly string[]): CliOptions {
  let command = "help";
  let root = process.cwd();
  let json = false;
  let force = false;
  let dryRun = false;
  let allowDowngrade = false;
  let interactive = false;
  let preset: string | undefined;
  let name: string | undefined;
  let selectedArchitecture: ProjectArchitecture | undefined;
  let targetVersion: number | undefined;
  let backup: string | undefined;
  let languages: readonly string[] | undefined;
  let frameworks: readonly string[] | undefined;
  let targets: readonly string[] | undefined;
  let packs: readonly string[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") command = "help";
    else if (argument === "--json") json = true;
    else if (argument === "--force") force = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--allow-downgrade") allowDowngrade = true;
    else if (argument === "--interactive") interactive = true;
    else if (argument === "--preset") {
      preset = optionValue(args, index, "--preset requires a registered initialization preset.");
      index += 1;
    } else if (argument === "--root") {
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
    } else if (argument === "--packs") {
      const value = optionValue(args, index, "--packs requires a comma-separated list.");
      packs = splitList(value);
      index += 1;
    } else if (argument === "--name") {
      name = optionValue(args, index, "--name requires a project name.");
      index += 1;
    } else if (argument === "--architecture") {
      const value = optionValue(args, index, "--architecture requires a value.");
      selectedArchitecture = architecture(value);
      index += 1;
    } else if (argument === "--to") {
      const value = optionValue(args, index, "--to requires a schema version.");
      targetVersion = positiveInteger(value, "--to");
      index += 1;
    } else if (argument === "--backup") {
      backup = optionValue(args, index, "--backup requires a path.");
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new AiyokeError("INVALID_SPEC", `Unknown option ${argument}.`);
    } else if (command === "help") command = argument;
    else throw new AiyokeError("INVALID_SPEC", `Unexpected argument ${argument}.`);
  }

  const normalizedOptions = args
    .filter((argument) => argument.startsWith("-"))
    .map((argument) => (argument === "-h" ? "--help" : argument));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) {
    throw new AiyokeError("INVALID_SPEC", "CLI options cannot be repeated.");
  }
  const common = ["--root", "--json", "--help"];
  const commandOptions: Readonly<Record<string, readonly string[]>> = {
    help: common,
    init: [...common, "--force", "--preset", "--languages", "--frameworks", "--targets"],
    plan: common,
    apply: common,
    check: common,
    doctor: common,
    detect: common,
    list: common,
    config: [
      ...common,
      "--dry-run",
      "--interactive",
      "--name",
      "--architecture",
      "--languages",
      "--frameworks",
      "--targets",
      "--packs"
    ],
    migrate: [...common, "--dry-run", "--allow-downgrade", "--to"],
    rollback: [...common, "--dry-run", "--backup"]
  };
  const allowed = new Set(commandOptions[command] ?? common);
  const unsupported = normalizedOptions.filter((option) => !allowed.has(option));
  if (unsupported.length > 0) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not valid for ${command}.`
    );
  }

  const optional = {
    ...(languages === undefined ? {} : { languages }),
    ...(frameworks === undefined ? {} : { frameworks }),
    ...(targets === undefined ? {} : { targets }),
    ...(packs === undefined ? {} : { packs }),
    ...(name === undefined ? {} : { name }),
    ...(selectedArchitecture === undefined ? {} : { architecture: selectedArchitecture }),
    ...(targetVersion === undefined ? {} : { targetVersion }),
    ...(backup === undefined ? {} : { backup }),
    ...(preset === undefined ? {} : { preset })
  };
  return { command, root, json, force, dryRun, allowDowngrade, interactive, ...optional };
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

function migrationText(result: import("../../engine/index.js").MigrationExecutionResult): string {
  if (!result.changed) return `schemaVersion ${result.toVersion} is already current.`;
  const verb = result.operation === "migrate" ? "migrate" : "roll back";
  if (result.dryRun) {
    return `Would ${verb} schemaVersion ${result.fromVersion} to ${result.toVersion}.\n\n${result.output}`;
  }
  return [
    `${result.operation === "migrate" ? "Migrated" : "Rolled back"} schemaVersion ${result.fromVersion} to ${result.toVersion}.`,
    ...(result.backupPath === undefined ? [] : [`Recovery backup: ${result.backupPath}`])
  ].join("\n");
}

function configurationText(result: import("../../engine/index.js").ConfigureResult): string {
  if (!result.changed) return result.output;
  if (result.dryRun) return `Would update aiyoke.yaml.\n\n${result.output}`;
  return [
    "Updated aiyoke.yaml.",
    ...(result.backupPath === undefined ? [] : [`Recovery backup: ${result.backupPath}`])
  ].join("\n");
}

export async function runCli(
  args = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<number> {
  let options: CliOptions | undefined;
  try {
    options = parseArguments(args);
    if (options.command === "help") {
      emit(CLI_HELP, false);
      return 0;
    }

    const { AiyokeEngine } = await import("../../engine/index.js");
    const engine = await AiyokeEngine.open(options.root);
    if (options.command === "init") {
      const result = await engine.initialize({
        force: options.force,
        ...(options.preset === undefined ? {} : { preset: extensionId(options.preset) }),
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
    if (options.command === "config") {
      const hasFlags =
        options.name !== undefined ||
        options.architecture !== undefined ||
        options.languages !== undefined ||
        options.frameworks !== undefined ||
        options.targets !== undefined ||
        options.packs !== undefined;
      if (options.interactive && hasFlags) {
        throw new AiyokeError(
          "INVALID_SPEC",
          "--interactive cannot be combined with deterministic configuration flags."
        );
      }
      if (options.interactive) {
        const inputIsTTY = runtime.inputIsTTY ?? process.stdin.isTTY === true;
        const outputIsTTY = runtime.outputIsTTY ?? process.stdout.isTTY === true;
        if (!inputIsTTY || !outputIsTTY) {
          throw new AiyokeError(
            "INVALID_SPEC",
            "Interactive configuration requires an input and output TTY. Use flags in automation."
          );
        }
        const prompt = runtime.prompt ?? createNodeConfigPrompt();
        try {
          const collected = await collectInteractiveConfiguration(await engine.loadSpec(), prompt);
          if (collected.kind === "cancelled") {
            emit("Configuration unchanged.", false);
            return 0;
          }
          const result = await engine.configure({ ...collected.options, dryRun: options.dryRun });
          emit(options.json ? result : configurationText(result), options.json);
          return 0;
        } finally {
          prompt.close();
        }
      }
      const result = await engine.configure({
        dryRun: options.dryRun || !hasFlags,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
        ...(options.languages === undefined
          ? {}
          : { languages: options.languages.map(extensionId) }),
        ...(options.frameworks === undefined
          ? {}
          : { frameworks: options.frameworks.map(extensionId) }),
        ...(options.targets === undefined
          ? {}
          : { targetAdapters: options.targets.map(extensionId) }),
        ...(options.packs === undefined ? {} : { packs: options.packs.map(extensionId) })
      });
      emit(options.json ? result : configurationText(result), options.json);
      return 0;
    }
    if (options.command === "migrate") {
      const result = await engine.migrate({
        dryRun: options.dryRun,
        allowDowngrade: options.allowDowngrade,
        ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion })
      });
      emit(options.json ? result : migrationText(result), options.json);
      return 0;
    }
    if (options.command === "rollback") {
      if (options.backup === undefined) {
        throw new AiyokeError("INVALID_SPEC", "rollback requires --backup <path>.");
      }
      const result = await engine.rollbackMigration(options.backup, { dryRun: options.dryRun });
      emit(options.json ? result : migrationText(result), options.json);
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
