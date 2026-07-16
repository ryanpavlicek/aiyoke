# Public API reference

Aiyoke exposes three intentional package entry points. Other files in `dist` are
implementation details even when present in the tarball.

## `aiyoke`

The root is a lightweight facade. Core/SDK values and types load eagerly; engine,
filesystem discovery, and process isolation are dynamically imported only when
called.

### `createAiyoke(options?)`

Opens an `AiyokeEngine` at `options.root` (current directory by default).
Application-owned `options.extensions` are registered during composition without
changing built-ins or core dispatch.

```ts
import { createAiyoke } from "aiyoke";

const aiyoke = await createAiyoke({ root: process.cwd(), extensions: [loader] });
const plan = await aiyoke.plan();
```

The engine exposes initialization, configuration, migration/rollback, detection,
listing, planning, applying, checking, and doctor use cases used by the CLI.

### `discoverSignedExtension(options)`

Hashes a bounded package tree, parses a strict schema-v1 manifest, verifies its
Ed25519 signature against supplied offline trust roots/revocations, and requires
consent bound to the exact manifest digest before import. It returns a
discriminated `loaded`, `consent-required`, or `rejected` result.

### `renderSignedExtensionIsolated(options)`

For signed target/runtime renderers, verifies without importing in the host,
serializes a bounded workspace snapshot, re-hashes/imports in a minimal child,
and returns `rendered`, `consent-required`, or a typed rejection. Limits cover
time, input/output bytes, workspace files, artifacts, and V8 heap; `AbortSignal`
cancels active work.

## `aiyoke/core`

The dependency-free domain surface exports:

- rich discriminated configuration/runtime/target/lifecycle types;
- `extensionId(value)` for stable lower-case kebab-case extension IDs;
- `safeRelativePath(value)` for normalized generated paths;
- `aggregateHarnessStack(composition)` for single/monorepo selection;
- production runtime defaults/policy resolution; and
- `AiyokeError` with stable error codes/details.

Consumers should not place provider clients, filesystem effects, or application
services in the core.

## `aiyoke/extension-sdk`

The SDK exports versioned extension descriptors/contracts, `defineTarget`,
`defineLanguage`, `defineFramework`, `definePack`, `defineRuntime`,
`ExtensionRegistry`, and `runExtensionCompatibility`.

Runtime ecosystem tooling can use `validateRuntimeCapabilityManifest()` and
`RUNTIME_CAPABILITY_FAMILY_IDS` from this subpath. The validator enforces the
versioned seven-family discriminated model, canonical artifact paths, composed
implemented/integration-port delivery, and an explicit set of acceptance
artifacts the caller will execute. It is intentionally not re-exported by the
lightweight root facade.

Signed-extension contracts include manifest parsing/signing payload generation,
trust/revocation/consent unions, verification results, and isolation options.
Cryptography is represented by `ManifestCryptoPort`; the Node implementation
lives behind the lazy facade.

Extension API compatibility is explicit through `EXTENSION_API_VERSION`. A
breaking SDK contract requires a new API version and migration notes, not a
silent structural change. See [Extension authoring](extensions.md) for complete
examples and publishing/security rules.
