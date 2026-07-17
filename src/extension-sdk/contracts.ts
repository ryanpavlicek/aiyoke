import type {
  ArtifactIntent,
  ExtensionId,
  HarnessModule,
  HarnessSpec,
  HarnessStack,
  RuntimeHarnessSpec,
  TargetSpec,
  VerificationFinding
} from "../core/index.js";

export const EXTENSION_API_VERSION = "1.0.0";

export type ExtensionKind = "target" | "language" | "framework" | "pack" | "runtime";

export interface ExtensionReference {
  readonly kind: ExtensionKind;
  readonly id: ExtensionId;
}

export interface ExtensionDescriptorBase {
  readonly id: ExtensionId;
  readonly version: string;
  readonly apiVersion: typeof EXTENSION_API_VERSION;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly requires: readonly ExtensionReference[];
  readonly conflicts: readonly ExtensionReference[];
}

export type ExtensionDescriptor =
  | (ExtensionDescriptorBase & { readonly kind: "target" })
  | (ExtensionDescriptorBase & { readonly kind: "language" })
  | (ExtensionDescriptorBase & { readonly kind: "framework" })
  | (ExtensionDescriptorBase & { readonly kind: "pack" })
  | (ExtensionDescriptorBase & { readonly kind: "runtime"; readonly language: ExtensionId });

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: readonly string[];
  read(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
}

export interface DetectionResult {
  readonly confidence: number;
  readonly reasons: readonly string[];
}

/** Pure extension contract consumed by the application-layer preset registry. */
export interface InitPresetContext {
  readonly defaults: HarnessSpec;
  readonly detectedLanguages: readonly ExtensionId[];
  readonly detectedFrameworks: readonly ExtensionId[];
}

export interface InitPresetSelection {
  readonly languages?: readonly ExtensionId[];
  readonly frameworks?: readonly ExtensionId[];
  readonly targetAdapters?: readonly ExtensionId[];
}

export interface InitPreset {
  readonly id: ExtensionId;
  readonly displayName: string;
  readonly description: string;
  select(context: InitPresetContext): InitPresetSelection;
}

export interface ContributionContext {
  readonly spec: HarnessSpec;
  readonly workspace: WorkspaceSnapshot;
}

export interface TargetRenderContext extends ContributionContext {
  readonly target: TargetSpec;
  readonly modules: readonly HarnessModule[];
}

export interface TargetVerificationContext extends ContributionContext {
  readonly target: TargetSpec;
}

export type RuntimeScope =
  | { readonly kind: "project"; readonly stack: HarnessStack }
  | {
      readonly kind: "workspace";
      readonly id: ExtensionId;
      readonly path: string;
      readonly stack: HarnessStack;
    };

export interface RuntimeRenderContext extends ContributionContext {
  readonly runtime: Extract<RuntimeHarnessSpec, { readonly kind: "enabled" }>;
  readonly scope: RuntimeScope;
}

export interface LanguageExtension {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "language" };
  detect(workspace: WorkspaceSnapshot): Promise<DetectionResult>;
  contribute(context: ContributionContext): Promise<HarnessModule>;
}

export interface FrameworkExtension {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "framework" };
  detect(workspace: WorkspaceSnapshot): Promise<DetectionResult>;
  contribute(context: ContributionContext): Promise<HarnessModule>;
}

export interface CapabilityPackExtension {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "pack" };
  contribute(context: ContributionContext): Promise<HarnessModule>;
}

export interface TargetExtension {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "target" };
  readonly surface: TargetSpec["kind"];
  render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]>;
  verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]>;
}

export interface RuntimeTemplateExtension {
  readonly descriptor: ExtensionDescriptor & { readonly kind: "runtime" };
  render(context: RuntimeRenderContext): Promise<readonly ArtifactIntent[]>;
}

export type AiyokeExtension =
  | LanguageExtension
  | FrameworkExtension
  | CapabilityPackExtension
  | TargetExtension
  | RuntimeTemplateExtension;

export interface ExtensionLoader<T extends AiyokeExtension = AiyokeExtension> {
  readonly descriptor: T["descriptor"];
  load(): Promise<T>;
}

export function defineLanguage<T extends LanguageExtension>(extension: T): T {
  return extension;
}

export function defineFramework<T extends FrameworkExtension>(extension: T): T {
  return extension;
}

export function definePack<T extends CapabilityPackExtension>(extension: T): T {
  return extension;
}

export function defineTarget<T extends TargetExtension>(extension: T): T {
  return extension;
}

export function defineRuntime<T extends RuntimeTemplateExtension>(extension: T): T {
  return extension;
}
