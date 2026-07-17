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

## Discover a signed package

Programmatic loaders are appropriate for application-owned composition. For an
installable third-party package, use the signed discovery adapter exported by
the lazy public facade. Discovery reads a strict, bounded manifest, hashes the
complete package tree, verifies an Ed25519 signature against an application-owned
trust store, applies revocations, and returns a consent request without importing
the package:

```ts
import { discoverSignedExtension } from "aiyoke";

const trust = {
  roots: [{ keyId: "publisher-2026", publicKeyPem }],
  revokedKeyIds: [],
  revokedContentDigests: [],
  revokedManifestDigests: []
};

const pending = await discoverSignedExtension({
  manifestPath: "./downloads/example/aiyoke-extension.json",
  packageRoot: "./downloads/example/package",
  trust,
  consent: { kind: "pending" }
});

if (pending.kind === "consent-required") {
  // Show the signed descriptor, publisher key ID, and exact manifest digest.
  // Persist approval only after an explicit user decision.
  const loaded = await discoverSignedExtension({
    manifestPath: "./downloads/example/aiyoke-extension.json",
    packageRoot: "./downloads/example/package",
    trust,
    consent: { kind: "granted", manifestDigest: pending.manifestDigest }
  });
}
```

Consent is bound to the canonical manifest digest, so changing the descriptor,
entrypoint, version, package digest, or publisher invalidates prior approval.
Denied, mismatched, unsigned, untrusted, revoked, symlinked, oversized, or
tampered packages fail before module import. After verification, discovery
checks the package a second time and requires the imported loader descriptor to
exactly match the signed descriptor.

The manifest format is versioned and deliberately narrow:

```json
{
  "schemaVersion": 1,
  "extension": {
    "kind": "pack",
    "id": "example-pack",
    "version": "1.0.0",
    "apiVersion": "1.0.0",
    "displayName": "Example pack",
    "description": "Example signed extension.",
    "capabilities": ["instructions"],
    "requires": [],
    "conflicts": []
  },
  "package": {
    "name": "@example/aiyoke-pack",
    "version": "1.0.0",
    "entrypoint": "index.mjs",
    "exportName": "loader"
  },
  "content": {
    "algorithm": "sha256",
    "digest": "sha256:<64 lowercase hexadecimal characters>"
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "publisher-2026",
    "value": "<base64 signature of the canonical manifest payload>"
  }
}
```

The trust store and consent decision are integration ports: Aiyoke does not
silently download trust roots, choose publishers, or grant execution. Hosts can
back those ports with a checked-in enterprise policy, an offline bundle, or an
audited service. Renderer process isolation is a separate defense; a valid
signature establishes identity and integrity, not that the code is harmless.

For target and runtime renderers, the optional isolation facade verifies the
same signed package without importing it into the host and executes `render()`
through a versioned child-process protocol:

```ts
import { renderSignedExtensionIsolated } from "aiyoke";

const result = await renderSignedExtensionIsolated({
  manifestPath,
  packageRoot,
  trust,
  consent: { kind: "granted", manifestDigest },
  invocation: {
    kind: "target-render",
    context: { spec, target, modules, workspace }
  },
  limits: {
    timeoutMs: 5_000,
    maxInputBytes: 16 * 1024 * 1024,
    maxOutputBytes: 2 * 1024 * 1024,
    maxWorkspaceFiles: 2_000,
    maxArtifacts: 512,
    memoryMb: 128
  },
  signal
});
```

The adapter sends a bounded immutable workspace snapshot, exposes only a small
non-secret environment, applies a V8 heap limit, honors deadlines and
`AbortSignal` cancellation, ignores renderer stdout as a protocol channel, and
validates artifact paths and structure in both processes. The child re-hashes
the package immediately before import. Failures return a discriminated rejection
instead of renderer-controlled error text.

Process isolation limits accidental authority and contains crashes; it is not an
operating-system sandbox. A renderer may still access resources available to its
OS user, including absolute filesystem paths and network sockets. Run genuinely
untrusted code inside an additional container, VM, or platform sandbox with an
appropriate filesystem and network policy.

## Run the compatibility kit

Before publishing a loader, execute the public kit with a representative typed
fixture. It is exported from `aiyoke/extension-sdk` and does not import the
engine, filesystem adapters, built-in extensions, or private internals:

```ts
import { runExtensionCompatibility } from "aiyoke/extension-sdk";

const report = await runExtensionCompatibility({
  loader,
  dependencies: [],
  fixture: {
    spec,
    target,
    modules: [],
    files: { "package.json": "{}" },
    secretCanaries: ["value-that-must-never-appear"]
  }
});

if (report.kind === "failed") {
  throw new Error(JSON.stringify(report.findings));
}
```

The kit loads through a fresh registry, freezes and resolves the dependency
graph, checks complete descriptor identity, executes the extension twice against
the same immutable snapshot, and rejects nondeterministic, oversized,
path-unsafe, CRLF, duplicate-path, or secret-bearing output. Language/framework
fixtures validate detection confidence; target and runtime fixtures validate
their render contracts. Findings redact configured canaries even when a hostile
loader includes one in an exception.

Runtime extensions that emit `capabilities.json` can validate the manifest with
`validateRuntimeCapabilityManifest()` from `aiyoke/extension-sdk`. Pass the exact
acceptance artifact set your CI executes; the validator rejects any claim that
references a different or unsafe path. A port-backed claim must name its contract
and include at least one generated template plus an executed acceptance artifact.

Declare required extensions in `descriptor.requires`, and mutually exclusive
extensions in `descriptor.conflicts`. Do not reach into another extension's
private files to call it. The registry resolves requirements in deterministic
dependency-first order, rejects missing requirements/cycles/conflicts, and
memoizes each loader's promise so a lazy extension is loaded at most once.

## Verification and finding codes

Verification returns structured `VerificationFinding` values. Use an `error`
when the target artifact cannot be trusted, a `warning` for provider drift or
an optional capability, and `info` for a successful readiness signal. Built-in
codes, exit behavior, stability expectations, and remediation are cataloged in
[Errors and findings](errors-and-findings.md#built-in-verification-findings).
Extension-defined codes remain valid and intentionally open; prefix them with a
stable publisher/extension namespace and document them for downstream tooling.

Verification must not silently repair files. Findings should include a safe
relative `path` and target ID when they make the problem more actionable, and
must never include credentials or renderer-controlled secrets.

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

Use `ownership: "managed-section"` only for files that may contain user-authored
content. Aiyoke wraps the rendered content in distinct start/end markers, appends
the section when no markers exist, replaces only the bounded section on later
runs, and reports malformed or duplicated markers as conflicts. Generated and
user-owned artifacts retain their stricter whole-file behavior.

## Layer boundaries

Extension code may import `aiyoke/core`, `aiyoke/extension-sdk`, and helpers in
`src/extensions/shared`. It must not import application services, infrastructure
adapters, CLI/interfaces, or another extension's implementation. Ask the engine
for composition through a loader or contract instead. The architecture check
will reject forbidden local static imports.

## Trust model and deployment

An extension can execute code, commands, hooks, and MCP transports. Review it as
you would any dependency, pin the version, use signed discovery for installable
third-party packages, and document network/process access. A signature proves
the approved publisher identity and package integrity; it does not prove that
the code is safe. Trust roots, revocations, and consent are application-owned
policy, not an implicit Aiyoke download or approval service.

The optional renderer adapter runs a bounded child process with a reduced
environment, input/output limits, a deadline, cancellation, and result checks.
This is defense in depth and crash containment, not an OS sandbox. The process
can still use resources available to its OS user, including network sockets and
absolute filesystem paths. Run untrusted or unreviewed renderers in a container,
VM, or equivalent filesystem/network sandbox with least privilege, and retain
signature and consent checks there.

Never place API keys in descriptors, artifact content, fixtures, snapshots, or
logs; use an environment-variable reference.

Add focused tests for detection, contribution ordering, rendering, verification,
and conflict behavior. Include at least one fixture for an empty/minimal
workspace and run `pnpm check` before publishing. The extension API version is
explicit (`EXTENSION_API_VERSION`); a breaking contract requires a deliberate
version change and migration notes.
