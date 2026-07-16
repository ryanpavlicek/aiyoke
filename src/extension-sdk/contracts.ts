import type {
  ArtifactIntent,
  ExtensionId,
  HarnessModule,
  HarnessSpec,
  TargetSpec,
  VerificationFinding
} from "../core/index.js";

export const EXTENSION_API_VERSION = "1.0.0";

export type ExtensionKind = "target" | "language" | "framework" | "pack";

export interface ExtensionReference {
  readonly kind: ExtensionKind;
  readonly id: ExtensionId;
}

export interface ExtensionDescriptor {
  readonly kind: ExtensionKind;
  readonly id: ExtensionId;
  readonly version: string;
  readonly apiVersion: typeof EXTENSION_API_VERSION;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly requires: readonly ExtensionReference[];
  readonly conflicts: readonly ExtensionReference[];
}

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

export type AiyokeExtension =
  | LanguageExtension
  | FrameworkExtension
  | CapabilityPackExtension
  | TargetExtension;

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
