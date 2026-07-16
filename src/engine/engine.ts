import { basename } from "node:path";
import {
  type AppliedMigration,
  type ApplyResult,
  HarnessCompiler,
  type SchemaMigrationRegistry
} from "../application/index.js";
import {
  AiyokeError,
  aggregateHarnessStack,
  compareCodePoints,
  type ExtensionId,
  type HarnessPlan,
  type HarnessSpec,
  type ProjectArchitecture,
  safeRelativePath,
  type TargetSpec,
  type VerificationFinding
} from "../core/index.js";
import type {
  DetectionResult,
  ExtensionDescriptor,
  ExtensionLoader,
  ExtensionRegistry,
  FrameworkExtension,
  LanguageExtension
} from "../extension-sdk/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  createSchemaMigrationRegistry,
  defaultHarnessSpec,
  parseHarnessSpec,
  parseSchemaDocument,
  stringifyHarnessSpec,
  stringifySchemaDocument
} from "../infrastructure/config/index.js";
import { NodeWorkspace } from "../infrastructure/filesystem/index.js";
import { Sha256Hash } from "../infrastructure/hashing/index.js";
import { createDefaultRegistry } from "./registry.js";

export interface InitializeOptions {
  readonly languages?: readonly ExtensionId[];
  readonly frameworks?: readonly ExtensionId[];
  readonly targetAdapters?: readonly ExtensionId[];
  readonly force?: boolean;
}

export interface InitializeResult {
  readonly path: "aiyoke.yaml";
  readonly created: boolean;
  readonly spec: HarnessSpec;
}

export interface ConfigureOptions {
  readonly name?: string;
  readonly architecture?: ProjectArchitecture;
  readonly languages?: readonly ExtensionId[];
  readonly frameworks?: readonly ExtensionId[];
  readonly targetAdapters?: readonly ExtensionId[];
  readonly packs?: readonly ExtensionId[];
  readonly dryRun?: boolean;
}

export interface ConfigureResult {
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly spec: HarnessSpec;
  readonly output: string;
  readonly backupPath?: string;
}

export interface DetectedExtension {
  readonly descriptor: ExtensionDescriptor;
  readonly detection: DetectionResult;
}

export interface EngineOptions {
  readonly extensions?: readonly ExtensionLoader[];
}

export interface MigrateOptions {
  readonly targetVersion?: number;
  readonly allowDowngrade?: boolean;
  readonly dryRun?: boolean;
}

export interface MigrationExecutionResult {
  readonly operation: "migrate" | "rollback";
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly applied: readonly AppliedMigration[];
  readonly backupPath?: string;
  readonly output: string;
}

export class AiyokeEngine {
  readonly #workspace: NodeWorkspace;
  readonly #compiler: HarnessCompiler;
  readonly #registry: ExtensionRegistry;
  readonly #migrations: SchemaMigrationRegistry;
  readonly #hash: Sha256Hash;

  private constructor(workspace: NodeWorkspace, options: EngineOptions) {
    this.#workspace = workspace;
    this.#registry = createDefaultRegistry(options.extensions);
    this.#migrations = createSchemaMigrationRegistry();
    this.#hash = new Sha256Hash();
    this.#compiler = new HarnessCompiler(this.#registry, workspace, this.#hash);
  }

  static async open(root = process.cwd(), options: EngineOptions = {}): Promise<AiyokeEngine> {
    return new AiyokeEngine(await NodeWorkspace.open(root), options);
  }

  get root(): string {
    return this.#workspace.root;
  }

  listExtensions(): readonly ExtensionDescriptor[] {
    return this.#registry.list().map((loader) => loader.descriptor);
  }

  async detect(): Promise<readonly DetectedExtension[]> {
    const detected: DetectedExtension[] = [];
    for (const loader of this.#registry.list()) {
      if (loader.descriptor.kind !== "language" && loader.descriptor.kind !== "framework") continue;
      const extension = await this.#registry.get(loader.descriptor);
      const detection = await (extension as LanguageExtension | FrameworkExtension).detect(
        this.#workspace
      );
      if (detection.confidence > 0) detected.push({ descriptor: loader.descriptor, detection });
    }
    return detected.sort(
      (left, right) =>
        right.detection.confidence - left.detection.confidence ||
        compareCodePoints(left.descriptor.id, right.descriptor.id)
    );
  }

  async initialize(options: InitializeOptions = {}): Promise<InitializeResult> {
    const existing = await this.#workspace.read("aiyoke.yaml");
    if (existing !== undefined && options.force !== true) {
      return { path: "aiyoke.yaml", created: false, spec: parseHarnessSpec(existing) };
    }

    const defaults = defaultHarnessSpec(basename(this.#workspace.root));
    const defaultStack = aggregateHarnessStack(defaults.composition);
    const detected = await this.detect();
    const detectedLanguages = detected
      .filter((item) => item.descriptor.kind === "language" && item.detection.confidence >= 0.6)
      .map((item) => item.descriptor.id);
    const detectedFrameworks = detected
      .filter((item) => item.descriptor.kind === "framework" && item.detection.confidence >= 0.75)
      .map((item) => item.descriptor.id);
    const selectedTargets = this.#selectTargets(defaults.targets, options.targetAdapters);
    const spec: HarnessSpec = {
      ...defaults,
      composition: {
        kind: "single",
        stack: {
          languages:
            options.languages ??
            (detectedLanguages.length > 0 ? detectedLanguages : defaultStack.languages),
          frameworks: options.frameworks ?? detectedFrameworks
        }
      },
      targets: selectedTargets
    };
    await this.#workspace.writeAtomic("aiyoke.yaml", stringifyHarnessSpec(spec), false);
    return { path: "aiyoke.yaml", created: true, spec };
  }

  async loadSpec(): Promise<HarnessSpec> {
    const source = await this.#workspace.read("aiyoke.yaml");
    if (source === undefined) {
      throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml was not found. Run `aiyoke init` first.");
    }
    return parseHarnessSpec(source);
  }

  async configure(options: ConfigureOptions = {}): Promise<ConfigureResult> {
    const source = await this.#requiredConfigSource();
    const current = parseHarnessSpec(source);
    const defaults = defaultHarnessSpec(current.project.name);
    const composition =
      options.languages === undefined && options.frameworks === undefined
        ? current.composition
        : current.composition.kind === "single"
          ? {
              kind: "single" as const,
              stack: {
                languages: options.languages ?? current.composition.stack.languages,
                frameworks: options.frameworks ?? current.composition.stack.frameworks
              }
            }
          : {
              ...current.composition,
              root: {
                languages: options.languages ?? current.composition.root.languages,
                frameworks: options.frameworks ?? current.composition.root.frameworks
              }
            };
    const candidate: HarnessSpec = {
      ...current,
      project: {
        name: options.name ?? current.project.name,
        architecture: options.architecture ?? current.project.architecture
      },
      composition,
      targets:
        options.targetAdapters === undefined
          ? current.targets
          : this.#selectTargets(defaults.targets, options.targetAdapters, current.targets),
      packs: options.packs ?? current.packs
    };
    const validated = parseHarnessSpec(stringifyHarnessSpec(candidate));
    const output = stringifyHarnessSpec(validated);
    await this.#validateSelections(validated);
    const changed = output !== source;
    const dryRun = options.dryRun === true;
    if (!changed || dryRun) return { changed, dryRun, spec: validated, output };

    const backupPath = await this.#backup(source, current.schemaVersion);
    await this.#assertConfigUnchanged(source);
    await this.#workspace.writeAtomic("aiyoke.yaml", output, false);
    return { changed, dryRun, spec: validated, output, backupPath };
  }

  async migrate(options: MigrateOptions = {}): Promise<MigrationExecutionResult> {
    const source = await this.#requiredConfigSource();
    const document = parseSchemaDocument(source);
    const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION;
    const migration = this.#migrations.migrate(
      document,
      targetVersion,
      options.allowDowngrade === undefined ? {} : { allowDowngrade: options.allowDowngrade }
    );
    this.#validateMigratedDocument(migration.document);
    const output =
      migration.applied.length === 0
        ? source
        : targetVersion === CURRENT_SCHEMA_VERSION
          ? stringifyHarnessSpec(parseHarnessSpec(stringifySchemaDocument(migration.document)))
          : stringifySchemaDocument(migration.document);
    const changed = output !== source;
    const dryRun = options.dryRun === true;
    if (!changed || dryRun) {
      return {
        operation: "migrate",
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
        changed,
        dryRun,
        applied: migration.applied,
        output
      };
    }

    const backupPath = await this.#backup(source, document.schemaVersion);
    await this.#assertConfigUnchanged(source);
    await this.#workspace.writeAtomic("aiyoke.yaml", output, false);
    return {
      operation: "migrate",
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      changed,
      dryRun,
      applied: migration.applied,
      backupPath,
      output
    };
  }

  async rollbackMigration(
    backup: string,
    options: { readonly dryRun?: boolean } = {}
  ): Promise<MigrationExecutionResult> {
    const backupPath = safeRelativePath(backup);
    if (!backupPath.startsWith(".aiyoke/backups/aiyoke.v") || !backupPath.endsWith(".yaml")) {
      throw new AiyokeError(
        "INVALID_PATH",
        "Migration backups must be .yaml files under .aiyoke/backups."
      );
    }
    const output = await this.#workspace.read(backupPath);
    if (output === undefined) {
      throw new AiyokeError("WORKSPACE_IO", `Migration backup ${backupPath} was not found.`);
    }
    const restored = parseSchemaDocument(output);
    this.#validateMigratedDocument(restored);
    const source = await this.#requiredConfigSource();
    const current = parseSchemaDocument(source);
    const changed = output !== source;
    const dryRun = options.dryRun === true;
    if (!changed || dryRun) {
      return {
        operation: "rollback",
        fromVersion: current.schemaVersion,
        toVersion: restored.schemaVersion,
        changed,
        dryRun,
        applied: [],
        output
      };
    }

    const safetyBackup = await this.#backup(source, current.schemaVersion);
    await this.#assertConfigUnchanged(source);
    await this.#workspace.writeAtomic("aiyoke.yaml", output, false);
    return {
      operation: "rollback",
      fromVersion: current.schemaVersion,
      toVersion: restored.schemaVersion,
      changed,
      dryRun,
      applied: [],
      backupPath: safetyBackup,
      output
    };
  }

  async plan(): Promise<HarnessPlan> {
    return this.#compiler.plan(await this.loadSpec());
  }

  async apply(): Promise<ApplyResult> {
    return this.#compiler.apply(await this.plan());
  }

  async check(): Promise<readonly VerificationFinding[]> {
    return this.#compiler.verify(await this.loadSpec());
  }

  async doctor(): Promise<readonly VerificationFinding[]> {
    const spec = await this.loadSpec();
    const stack = aggregateHarnessStack(spec.composition);
    const findings = [...(await this.#compiler.verify(spec))];
    if (stack.languages.length === 0) {
      findings.push({
        severity: "warning",
        code: "NO_LANGUAGES",
        message: "No language extensions are selected."
      });
    }
    if (spec.targets.length === 0) {
      findings.push({
        severity: "error",
        code: "NO_TARGETS",
        message: "No AI harness targets are selected."
      });
    }
    if (!findings.some((finding) => finding.severity === "error")) {
      findings.push({
        severity: "info",
        code: "READY",
        message: "Configuration, extensions, and generated artifacts are healthy."
      });
    }
    return findings;
  }

  async #requiredConfigSource(): Promise<string> {
    const source = await this.#workspace.read("aiyoke.yaml");
    if (source === undefined) {
      throw new AiyokeError("INVALID_SPEC", "aiyoke.yaml was not found. Run `aiyoke init` first.");
    }
    return source;
  }

  #selectTargets(
    defaults: readonly TargetSpec[],
    adapters: readonly ExtensionId[] | undefined,
    current: readonly TargetSpec[] = []
  ): readonly TargetSpec[] {
    if (adapters === undefined) return defaults;
    if (new Set(adapters).size !== adapters.length) {
      throw new AiyokeError("INVALID_SPEC", "Selected targets cannot contain duplicates.");
    }
    return adapters.map((adapter) => {
      const existing = current.find((candidate) => candidate.adapter === adapter);
      if (existing !== undefined) return existing;
      const target = defaults.find((candidate) => candidate.adapter === adapter);
      if (target === undefined) {
        throw new AiyokeError(
          "INVALID_SPEC",
          `Target ${adapter} does not have a built-in initialization profile.`
        );
      }
      return target;
    });
  }

  async #validateSelections(spec: HarnessSpec): Promise<void> {
    const stack = aggregateHarnessStack(spec.composition);
    await this.#registry.resolve([
      ...stack.languages.map((id) => ({ kind: "language" as const, id })),
      ...stack.frameworks.map((id) => ({ kind: "framework" as const, id })),
      ...spec.targets.map((target) => ({ kind: "target" as const, id: target.adapter })),
      ...spec.packs.map((id) => ({ kind: "pack" as const, id }))
    ]);
  }

  #validateMigratedDocument(document: import("../application/index.js").SchemaDocument): void {
    if (document.schemaVersion === CURRENT_SCHEMA_VERSION) {
      parseHarnessSpec(stringifySchemaDocument(document));
      return;
    }
    const upgraded = this.#migrations.migrate(document, CURRENT_SCHEMA_VERSION);
    parseHarnessSpec(stringifySchemaDocument(upgraded.document));
  }

  async #backup(source: string, schemaVersion: number): Promise<string> {
    const digest = this.#hash.digest(source).slice(0, 16);
    const path = `.aiyoke/backups/aiyoke.v${schemaVersion}-${digest}.yaml`;
    const existing = await this.#workspace.read(path);
    if (existing === undefined) await this.#workspace.writeAtomic(path, source, false);
    else if (existing !== source) {
      throw new AiyokeError("WORKSPACE_IO", `Migration backup collision at ${path}.`);
    }
    return path;
  }

  async #assertConfigUnchanged(expected: string): Promise<void> {
    if ((await this.#workspace.read("aiyoke.yaml")) !== expected) {
      throw new AiyokeError(
        "PLAN_CONFLICT",
        "aiyoke.yaml changed while the migration was being prepared; no replacement was written."
      );
    }
  }
}
