export type {
  ArtifactIntent,
  HarnessModule,
  HarnessPlan,
  HarnessSpec,
  MonorepoWorkspace,
  PlanOperation,
  ProjectComposition,
  RuntimeHarnessSpec,
  RuntimePolicy,
  TargetSpec,
  VerificationFinding
} from "./core/index.js";
export { AiyokeError, aggregateHarnessStack, extensionId, safeRelativePath } from "./core/index.js";
export type {
  AiyokeExtension,
  CapabilityPackExtension,
  CompatibilityFixture,
  CompatibilityReport,
  CompatibilityRunOptions,
  ExtensionDescriptor,
  ExtensionLoader,
  FrameworkExtension,
  IsolatedRendererResult,
  IsolatedSignedExtensionOptions,
  LanguageExtension,
  RuntimeTemplateExtension,
  SignedExtensionDiscoveryOptions,
  SignedExtensionDiscoveryResult,
  SignedExtensionManifest,
  TargetExtension
} from "./extension-sdk/index.js";
export {
  defineFramework,
  defineLanguage,
  definePack,
  defineRuntime,
  defineTarget,
  EXTENSION_API_VERSION,
  ExtensionRegistry,
  runExtensionCompatibility
} from "./extension-sdk/index.js";

export interface CreateAiyokeOptions {
  readonly root?: string;
  readonly extensions?: readonly RegisteredExtensionLoader[];
}

export async function createAiyoke(
  options: CreateAiyokeOptions = {}
): Promise<import("./engine/index.js").AiyokeEngine> {
  const { AiyokeEngine } = await import("./engine/index.js");
  return AiyokeEngine.open(
    options.root,
    options.extensions === undefined ? {} : { extensions: options.extensions }
  );
}

export async function discoverSignedExtension(
  options: SignedDiscoveryOptions
): Promise<SignedDiscoveryResult> {
  const discovery = await import("./infrastructure/discovery/index.js");
  return discovery.discoverSignedExtension(options);
}

export async function renderSignedExtensionIsolated(
  options: SignedIsolationOptions
): Promise<SignedIsolationResult> {
  const isolation = await import("./infrastructure/isolation/index.js");
  return isolation.renderSignedExtensionIsolated(options);
}

import type {
  ExtensionLoader as RegisteredExtensionLoader,
  SignedExtensionDiscoveryOptions as SignedDiscoveryOptions,
  SignedExtensionDiscoveryResult as SignedDiscoveryResult,
  IsolatedSignedExtensionOptions as SignedIsolationOptions,
  IsolatedRendererResult as SignedIsolationResult
} from "./extension-sdk/index.js";
