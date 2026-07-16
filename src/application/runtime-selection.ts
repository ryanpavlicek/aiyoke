import { AiyokeError, compareCodePoints, type ExtensionId } from "../core/index.js";
import type {
  ExtensionReference,
  ExtensionRegistry,
  RuntimeTemplateExtension
} from "../extension-sdk/index.js";

export function runtimeTemplateReferences(
  registry: ExtensionRegistry,
  languages: readonly ExtensionId[]
): readonly ExtensionReference[] {
  return [...new Set(languages)].sort(compareCodePoints).map((language) => {
    const matches = registry
      .list("runtime")
      .filter(
        (loader) => loader.descriptor.kind === "runtime" && loader.descriptor.language === language
      );
    if (matches.length === 0) {
      throw new AiyokeError(
        "EXTENSION_MISSING",
        `Runtime template for language:${language} is not registered.`
      );
    }
    if (matches.length > 1) {
      throw new AiyokeError(
        "EXTENSION_DUPLICATE",
        `Multiple runtime templates are registered for language:${language}.`
      );
    }
    const match = matches[0];
    if (match === undefined) throw new AiyokeError("EXTENSION_MISSING", "Runtime disappeared.");
    return { kind: "runtime" as const, id: match.descriptor.id };
  });
}

export async function loadRuntimeTemplate(
  registry: ExtensionRegistry,
  reference: ExtensionReference
): Promise<RuntimeTemplateExtension> {
  const extension = await registry.get(reference);
  if (extension.descriptor.kind !== "runtime") {
    throw new AiyokeError(
      "INVALID_SPEC",
      `Expected runtime extension, received ${extension.descriptor.kind}:${extension.descriptor.id}.`
    );
  }
  return extension as RuntimeTemplateExtension;
}
