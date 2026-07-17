import { AiyokeError, compareCodePoints, type ExtensionId, extensionId } from "../core/index.js";
import type { InitPreset } from "../extension-sdk/index.js";

export type {
  InitPreset,
  InitPresetContext,
  InitPresetSelection
} from "../extension-sdk/index.js";

function presetKey(preset: InitPreset): string {
  return preset.id;
}

/**
 * Registry for application-layer initialization presets.
 *
 * Presets return ordinary schema selections; they do not render artifacts or
 * add target/framework branches to the domain. This keeps the core stable and
 * makes custom presets additive through registration.
 */
export class InitPresetRegistry {
  readonly #presets = new Map<string, InitPreset>();
  #frozen = false;

  register(preset: InitPreset): this {
    if (this.#frozen) {
      throw new AiyokeError("REGISTRY_FROZEN", "The initialization preset registry is frozen.");
    }
    const id = extensionId(preset.id);
    if (preset.displayName.trim().length === 0 || preset.description.trim().length === 0) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `Initialization preset ${id} must have a display name and description.`
      );
    }
    if (this.#presets.has(id)) {
      throw new AiyokeError(
        "EXTENSION_DUPLICATE",
        `Initialization preset ${id} is already registered.`,
        { preset: id }
      );
    }
    this.#presets.set(id, { ...preset, id });
    return this;
  }

  get(id: ExtensionId): InitPreset {
    const preset = this.#presets.get(id);
    if (preset === undefined) {
      const available = this.list()
        .map((candidate) => candidate.id)
        .join(", ");
      throw new AiyokeError(
        "INVALID_SPEC",
        `Unknown initialization preset ${id}.${available.length === 0 ? "" : ` Available presets: ${available}.`}`,
        { preset: id, available: this.list().map((candidate) => candidate.id) }
      );
    }
    return preset;
  }

  has(id: ExtensionId): boolean {
    return this.#presets.has(id);
  }

  list(): readonly InitPreset[] {
    return [...this.#presets.values()].sort((left, right) =>
      compareCodePoints(presetKey(left), presetKey(right))
    );
  }

  freeze(): this {
    this.#frozen = true;
    return this;
  }

  get frozen(): boolean {
    return this.#frozen;
  }
}

/**
 * A deliberately small starting point for common Claude Code + OpenRouter
 * projects. The engine still performs normal language/framework detection,
 * while this preset limits the generated target surface to those two tools.
 */
const simpleInitPreset: InitPreset = Object.freeze({
  id: extensionId("simple"),
  displayName: "Simple Claude Code + OpenRouter",
  description:
    "Auto-detect the project stack and generate only Claude Code and OpenRouter targets.",
  select: () => ({
    targetAdapters: [extensionId("claude-code"), extensionId("openrouter")]
  })
});

export function createDefaultInitPresetRegistry(
  additional: readonly InitPreset[] = []
): InitPresetRegistry {
  const registry = new InitPresetRegistry().register(simpleInitPreset);
  for (const preset of additional) registry.register(preset);
  return registry.freeze();
}
