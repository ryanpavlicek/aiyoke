import { AiyokeError, compareCodePoints, type ExtensionId } from "../core/index.js";
import {
  type AiyokeExtension,
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  type ExtensionKind,
  type ExtensionLoader,
  type ExtensionReference
} from "./contracts.js";

function keyOf(reference: ExtensionReference): string {
  return `${reference.kind}:${reference.id}`;
}

function loaderKey(loader: ExtensionLoader): string {
  return keyOf(loader.descriptor);
}

export class ExtensionRegistry {
  readonly #loaders = new Map<string, ExtensionLoader>();
  readonly #loaded = new Map<string, Promise<AiyokeExtension>>();
  #frozen = false;

  register(loader: ExtensionLoader): this {
    if (this.#frozen) {
      throw new AiyokeError("REGISTRY_FROZEN", "The extension registry is frozen.");
    }
    if (loader.descriptor.apiVersion !== EXTENSION_API_VERSION) {
      throw new AiyokeError(
        "EXTENSION_API_MISMATCH",
        `Extension ${loaderKey(loader)} targets API ${loader.descriptor.apiVersion}; expected ${EXTENSION_API_VERSION}.`,
        { extension: loaderKey(loader), apiVersion: loader.descriptor.apiVersion }
      );
    }

    const key = loaderKey(loader);
    if (this.#loaders.has(key)) {
      throw new AiyokeError("EXTENSION_DUPLICATE", `Extension ${key} is already registered.`, {
        extension: key
      });
    }
    this.#loaders.set(key, loader);
    return this;
  }

  registerTarget(loader: ExtensionLoader): this {
    return this.#registerKind("target", loader);
  }

  registerLanguage(loader: ExtensionLoader): this {
    return this.#registerKind("language", loader);
  }

  registerFramework(loader: ExtensionLoader): this {
    return this.#registerKind("framework", loader);
  }

  registerPack(loader: ExtensionLoader): this {
    return this.#registerKind("pack", loader);
  }

  registerRuntime(loader: ExtensionLoader): this {
    if (loader.descriptor.kind !== "runtime") return this.#registerKind("runtime", loader);
    const language = loader.descriptor.language;
    const existing = this.list("runtime").find((candidate) => {
      const descriptor: ExtensionDescriptor = candidate.descriptor;
      return descriptor.kind === "runtime" && descriptor.language === language;
    });
    if (existing !== undefined) {
      throw new AiyokeError(
        "EXTENSION_DUPLICATE",
        `Runtime language ${loader.descriptor.language} is already owned by ${existing.descriptor.id}.`
      );
    }
    return this.register(loader);
  }

  #registerKind(kind: ExtensionKind, loader: ExtensionLoader): this {
    if (loader.descriptor.kind !== kind) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `Expected a ${kind} extension, received ${loader.descriptor.kind}:${loader.descriptor.id}.`
      );
    }
    return this.register(loader);
  }

  freeze(): this {
    this.#validateDependencyGraph();
    this.#frozen = true;
    return this;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  list(kind?: ExtensionKind): readonly ExtensionLoader[] {
    return [...this.#loaders.values()]
      .filter((loader) => kind === undefined || loader.descriptor.kind === kind)
      .sort((left, right) => compareCodePoints(loaderKey(left), loaderKey(right)));
  }

  has(reference: ExtensionReference): boolean {
    return this.#loaders.has(keyOf(reference));
  }

  async get(reference: ExtensionReference): Promise<AiyokeExtension> {
    const key = keyOf(reference);
    const loader = this.#loaders.get(key);
    if (loader === undefined) {
      throw new AiyokeError("EXTENSION_MISSING", `Extension ${key} is not registered.`, {
        extension: key
      });
    }

    const existing = this.#loaded.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const loaded = loader.load().then((extension) => {
      if (
        extension.descriptor.kind !== loader.descriptor.kind ||
        extension.descriptor.id !== loader.descriptor.id
      ) {
        throw new AiyokeError(
          "INVALID_SPEC",
          `Extension loader ${key} returned ${extension.descriptor.kind}:${extension.descriptor.id}.`
        );
      }
      return extension;
    });
    this.#loaded.set(key, loaded);
    return loaded;
  }

  async resolve(references: readonly ExtensionReference[]): Promise<readonly AiyokeExtension[]> {
    const selected = new Set<string>();
    const ordered: ExtensionReference[] = [];

    const visit = (reference: ExtensionReference): void => {
      const key = keyOf(reference);
      if (selected.has(key)) return;
      const loader = this.#loaders.get(key);
      if (loader === undefined) {
        throw new AiyokeError("EXTENSION_MISSING", `Extension ${key} is not registered.`, {
          extension: key
        });
      }
      selected.add(key);
      for (const requirement of loader.descriptor.requires) visit(requirement);
      ordered.push(reference);
    };

    for (const reference of [...references].sort((a, b) => compareCodePoints(keyOf(a), keyOf(b)))) {
      visit(reference);
    }

    for (const key of selected) {
      const loader = this.#loaders.get(key);
      if (loader === undefined) continue;
      for (const conflict of loader.descriptor.conflicts) {
        if (selected.has(keyOf(conflict))) {
          throw new AiyokeError(
            "EXTENSION_CONFLICT",
            `Extension ${key} conflicts with ${keyOf(conflict)}.`,
            { extension: key, conflict: keyOf(conflict) }
          );
        }
      }
    }

    return Promise.all(ordered.map((reference) => this.get(reference)));
  }

  reference(kind: ExtensionKind, id: ExtensionId): ExtensionReference {
    return { kind, id };
  }

  #validateDependencyGraph(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (key: string, chain: readonly string[]): void => {
      if (visited.has(key)) return;
      if (visiting.has(key)) {
        throw new AiyokeError(
          "EXTENSION_CYCLE",
          `Extension dependency cycle: ${[...chain, key].join(" -> ")}.`,
          {
            cycle: [...chain, key].join(" -> ")
          }
        );
      }
      const loader = this.#loaders.get(key);
      if (loader === undefined) {
        throw new AiyokeError("EXTENSION_MISSING", `Required extension ${key} is not registered.`, {
          extension: key
        });
      }
      visiting.add(key);
      for (const requirement of loader.descriptor.requires) {
        visit(keyOf(requirement), [...chain, key]);
      }
      visiting.delete(key);
      visited.add(key);
    };

    for (const key of [...this.#loaders.keys()].sort()) visit(key, []);
  }
}
