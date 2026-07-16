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
  ExtensionDescriptor,
  ExtensionLoader,
  FrameworkExtension,
  LanguageExtension,
  RuntimeTemplateExtension,
  TargetExtension
} from "./extension-sdk/index.js";
export {
  defineFramework,
  defineLanguage,
  definePack,
  defineRuntime,
  defineTarget,
  EXTENSION_API_VERSION,
  ExtensionRegistry
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

import type { ExtensionLoader as RegisteredExtensionLoader } from "./extension-sdk/index.js";
