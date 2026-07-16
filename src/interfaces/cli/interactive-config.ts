import { createInterface } from "node:readline/promises";
import {
  AiyokeError,
  extensionId,
  type HarnessSpec,
  type ProjectArchitecture
} from "../../core/index.js";
import type { ConfigureOptions } from "../../engine/index.js";

export interface ConfigPromptPort {
  question(prompt: string): Promise<string>;
  close(): void;
}

export type InteractiveConfigResult =
  | { readonly kind: "confirmed"; readonly options: ConfigureOptions }
  | { readonly kind: "cancelled" };

const ARCHITECTURES = new Set<ProjectArchitecture>(["layered", "hexagonal", "clean", "custom"]);

function isCancellation(value: string): boolean {
  return ["cancel", "quit", "q"].includes(value.trim().toLowerCase());
}

function list(value: string, fallback: readonly string[]) {
  if (value.trim().length === 0) return fallback.map(extensionId);
  if (new Set(["none", "-"]).has(value.trim().toLowerCase())) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(extensionId);
}

async function answer(
  prompt: ConfigPromptPort,
  label: string,
  fallback: string
): Promise<string | undefined> {
  const value = await prompt.question(`${label} [${fallback}]: `);
  if (isCancellation(value)) return undefined;
  return value.trim().length === 0 ? fallback : value.trim();
}

export async function collectInteractiveConfiguration(
  spec: HarnessSpec,
  prompt: ConfigPromptPort
): Promise<InteractiveConfigResult> {
  const stack = spec.composition.kind === "single" ? spec.composition.stack : spec.composition.root;
  const name = await answer(prompt, "Project name", spec.project.name);
  if (name === undefined) return { kind: "cancelled" };
  const architecture = await answer(prompt, "Architecture", spec.project.architecture);
  if (architecture === undefined) return { kind: "cancelled" };
  if (!ARCHITECTURES.has(architecture as ProjectArchitecture)) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `Architecture must be one of ${[...ARCHITECTURES].join(", ")}.`
    );
  }
  const languages = await answer(
    prompt,
    "Languages (comma-separated; none clears)",
    stack.languages.join(",")
  );
  if (languages === undefined) return { kind: "cancelled" };
  const frameworks = await answer(
    prompt,
    "Frameworks (comma-separated; none clears)",
    stack.frameworks.join(",")
  );
  if (frameworks === undefined) return { kind: "cancelled" };
  const targets = await answer(
    prompt,
    "Targets (comma-separated; none clears)",
    spec.targets.map((target) => target.adapter).join(",")
  );
  if (targets === undefined) return { kind: "cancelled" };
  const packs = await answer(
    prompt,
    "Capability packs (comma-separated; none clears)",
    spec.packs.join(",")
  );
  if (packs === undefined) return { kind: "cancelled" };
  const confirmation = await prompt.question("Apply these configuration changes? [y/N]: ");
  if (!new Set(["y", "yes"]).has(confirmation.trim().toLowerCase())) {
    return { kind: "cancelled" };
  }

  return {
    kind: "confirmed",
    options: {
      name,
      architecture: architecture as ProjectArchitecture,
      languages: list(languages, stack.languages),
      frameworks: list(frameworks, stack.frameworks),
      targetAdapters: list(
        targets,
        spec.targets.map((target) => target.adapter)
      ),
      packs: list(packs, spec.packs)
    }
  };
}

export function createNodeConfigPrompt(): ConfigPromptPort {
  return createInterface({ input: process.stdin, output: process.stdout });
}
