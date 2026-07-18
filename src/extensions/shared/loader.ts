import type { AiyokeExtension, ExtensionLoader } from "../../extension-sdk/index.js";

/** Build the canonical lazy loader for a statically defined extension. */
export function loaderFor<T extends AiyokeExtension>(extension: T): ExtensionLoader<T> {
  return {
    descriptor: extension.descriptor,
    load: async () => extension
  };
}
