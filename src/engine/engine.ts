import { basename } from "node:path";
import { type ApplyResult, HarnessCompiler } from "../application/index.js";
import {
  AiyokeError,
  compareCodePoints,
  type ExtensionId,
  type HarnessPlan,
  type HarnessSpec,
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
  defaultHarnessSpec,
  parseHarnessSpec,
  stringifyHarnessSpec
} from "../infrastructure/config/index.js";
import { NodeWorkspace } from "../infrastructure/filesystem/index.js";
import { Sha256Hash } from "../infrastructure/hashing/index.js";
import { createDefaultRegistry } from "./registry.js";

export interface InitializeOptions {
  readonly languages?: readonly ExtensionId[];
  readonly frameworks?: readonly ExtensionId[];
  readonly force?: boolean;
}

export interface InitializeResult {
  readonly path: "aiyoke.yaml";
  readonly created: boolean;
  readonly spec: HarnessSpec;
}

export interface DetectedExtension {
  readonly descriptor: ExtensionDescriptor;
  readonly detection: DetectionResult;
}

export interface EngineOptions {
  readonly extensions?: readonly ExtensionLoader[];
}

export class AiyokeEngine {
  readonly #workspace: NodeWorkspace;
  readonly #compiler: HarnessCompiler;
  readonly #registry: ExtensionRegistry;

  private constructor(workspace: NodeWorkspace, options: EngineOptions) {
    this.#workspace = workspace;
    this.#registry = createDefaultRegistry(options.extensions);
    this.#compiler = new HarnessCompiler(this.#registry, workspace, new Sha256Hash());
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
    const detected = await this.detect();
    const detectedLanguages = detected
      .filter((item) => item.descriptor.kind === "language" && item.detection.confidence >= 0.6)
      .map((item) => item.descriptor.id);
    const detectedFrameworks = detected
      .filter((item) => item.descriptor.kind === "framework" && item.detection.confidence >= 0.75)
      .map((item) => item.descriptor.id);
    const spec: HarnessSpec = {
      ...defaults,
      stack: {
        languages:
          options.languages ??
          (detectedLanguages.length > 0 ? detectedLanguages : defaults.stack.languages),
        frameworks: options.frameworks ?? detectedFrameworks
      }
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
    const findings = [...(await this.#compiler.verify(spec))];
    if (spec.stack.languages.length === 0) {
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
}
