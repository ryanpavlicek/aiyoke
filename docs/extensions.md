# Extension authoring

Extensions add targets, languages, frameworks, or capability packs without
changing the domain core. They are ordinary TypeScript modules that implement
the contracts exported by `aiyoke/extension-sdk` and are registered with an
`ExtensionRegistry` loader.

## Choose a kind

- **Language** detects a language and contributes language-specific instructions,
  skills, hooks, MCP servers, or subagents.
- **Framework** detects a framework and contributes framework conventions.
- **Pack** contributes an optional capability bundle without detection.
- **Target** renders a resolved module set into native artifacts and verifies
  those artifacts for one target surface (`coding-agent`, `chat-plugin`,
  `api-provider`, or `inference-gateway`).

An extension should do one job. A target adapter should not contain language
detection, and a language extension should not write files directly.

## Minimal target extension

```ts
import {
  defineTarget,
  type ExtensionLoader,
  type TargetExtension
} from "aiyoke/extension-sdk";
import { extensionId } from "aiyoke/core";

const target = defineTarget({
  descriptor: {
    kind: "target",
    id: extensionId("example-target"),
    version: "0.1.0",
    apiVersion: "1.0.0",
    displayName: "Example target",
    description: "Writes Example's native instruction file.",
    capabilities: ["instructions"],
    requires: [],
    conflicts: []
  },
  surface: "coding-agent",
  async render({ target: targetSpec, modules }) {
    // Build ArtifactIntent values; do not write to the workspace here.
    return [];
  },
  async verify({ target: targetSpec }) {
    return [];
  }
});

export const loader: ExtensionLoader<TargetExtension> = {
  descriptor: target.descriptor,
  async load() {
    return target;
  }
};
```

Use `defineLanguage`, `defineFramework`, or `definePack` for the other kinds.
The descriptor's `kind`, `id`, and `apiVersion` are checked when the loader is
registered. IDs are lower-case kebab-case and should remain stable forever;
changing an ID creates a new extension from the registry's perspective.

## Registration and dependencies

Register loaders during composition, then freeze before resolving a project:

```ts
registry
  .registerLanguage(languageLoader)
  .registerTarget(targetLoader)
  .freeze();

const modules = await registry.resolve(spec.packs.map((id) =>
  registry.reference("pack", id)
));
```

Pass additional loaders through the lazy public facade to use them in a real
engine without changing built-in composition or the core:

```ts
import { createAiyoke } from "aiyoke";

const engine = await createAiyoke({
  root: process.cwd(),
  extensions: [loader]
});
```

Declare required extensions in `descriptor.requires`, and mutually exclusive
extensions in `descriptor.conflicts`. Do not reach into another extension's
private files to call it. The registry resolves requirements in deterministic
dependency-first order, rejects missing requirements/cycles/conflicts, and
memoizes each loader's promise so a lazy extension is loaded at most once.

## Contribution rules

Detection is evidence, not mutation. Return a confidence in `[0, 1]` and
human-readable reasons; do not edit the workspace while detecting. Contribution
methods return `HarnessModule` values with stable IDs and explicit ownership.
Target renderers return `ArtifactIntent` values and must:

1. use safe relative paths;
2. sort repeated entries and use LF line endings;
3. avoid timestamps, random IDs, machine-specific absolute paths, and secrets;
4. preserve user-owned files and update only managed sections; and
5. produce the same bytes for the same spec, workspace snapshot, and module set.

Verification should report structured `VerificationFinding` values. A warning
is appropriate for provider drift or an optional capability; an error means the
target artifact cannot be trusted. Verification must not silently repair files.

## Layer boundaries

Extension code may import `aiyoke/core`, `aiyoke/extension-sdk`, and helpers in
`src/extensions/shared`. It must not import application services, infrastructure
adapters, CLI/interfaces, or another extension's implementation. Ask the engine
for composition through a loader or contract instead. The architecture check
will reject forbidden local static imports.

## Trust and release hygiene

An extension can execute code, commands, hooks, and MCP transports. Review it as
you would any dependency, pin the version, and document network/process access.
Never place API keys in descriptors, artifact content, fixtures, snapshots, or
logs; use an environment-variable reference.

Add focused tests for detection, contribution ordering, rendering, verification,
and conflict behavior. Include at least one fixture for an empty/minimal
workspace and run `pnpm check` before publishing. The extension API version is
explicit (`EXTENSION_API_VERSION`); a breaking contract requires a deliberate
version change and migration notes.
