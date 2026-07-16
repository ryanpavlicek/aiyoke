export type {
  ArtifactIntent,
  HarnessModule,
  HarnessPlan,
  HarnessSpec,
  PlanOperation,
  TargetSpec,
  VerificationFinding
} from "./core/index.js";
export { AiyokeError, extensionId, safeRelativePath } from "./core/index.js";
export type {
  AiyokeExtension,
  CapabilityPackExtension,
  ExtensionDescriptor,
  ExtensionLoader,
  FrameworkExtension,
  LanguageExtension,
  TargetExtension
} from "./extension-sdk/index.js";
export {
  defineFramework,
  defineLanguage,
  definePack,
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
