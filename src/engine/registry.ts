import { type ExtensionLoader, ExtensionRegistry } from "../extension-sdk/index.js";
import { frameworkLoaders } from "../extensions/frameworks/index.js";
import { languageLoaders } from "../extensions/languages/index.js";
import { engineeringPackLoader } from "../extensions/packs/index.js";
import {
  createChatGPTLoader,
  createClaudeCodeLoader,
  createCodexLoader,
  createGrokBuildLoader,
  createOpenRouterLoader,
  createXaiApiLoader
} from "../extensions/targets/index.js";

export function registerBuiltins(registry = new ExtensionRegistry()): ExtensionRegistry {
  for (const loader of languageLoaders) registry.registerLanguage(loader);
  for (const loader of frameworkLoaders) registry.registerFramework(loader);
  registry.registerPack(engineeringPackLoader);
  registry.registerTarget(createClaudeCodeLoader());
  registry.registerTarget(createCodexLoader());
  registry.registerTarget(createChatGPTLoader());
  registry.registerTarget(createGrokBuildLoader());
  registry.registerTarget(createXaiApiLoader());
  registry.registerTarget(createOpenRouterLoader());
  return registry;
}

export function createDefaultRegistry(
  additional: readonly ExtensionLoader[] = []
): ExtensionRegistry {
  const registry = registerBuiltins();
  for (const loader of additional) registry.register(loader);
  return registry.freeze();
}
