# Public API reference

Aiyoke exposes exactly three supported package entry points. Importing other
files from `dist` is unsupported even when those files are present in the npm
tarball. The generated `.d.ts` files are the machine-readable source of truth;
this document describes every exported value and type family intended for
consumers.

| Entry point | Purpose | Loading behavior |
| --- | --- | --- |
| `aiyoke` | Common facade, selected core/SDK contracts, engine creation, signed discovery/isolation | Heavy Node adapters load dynamically |
| `aiyoke/core` | Complete dependency-free domain and invariant surface | Eager and side-effect free |
| `aiyoke/extension-sdk` | Complete extension, registry, compatibility, signing, isolation, and runtime-capability contracts | Eager contracts; no Node filesystem adapter |

## `aiyoke`

The root entry point is the normal application API.

### `createAiyoke(options?)`

```ts
interface CreateAiyokeOptions {
  readonly root?: string;
  readonly extensions?: readonly ExtensionLoader[];
}

function createAiyoke(options?: CreateAiyokeOptions): Promise<AiyokeEngine>;
```

`root` defaults to `process.cwd()`. The function dynamically imports the engine,
opens/canonicalizes the workspace, composes first-party loaders, and registers
application-owned loaders before freezing resolution. It does not read a
provider credential or generate files merely by opening.

```ts
import { createAiyoke } from "aiyoke";

const aiyoke = await createAiyoke({ root: process.cwd(), extensions: [loader] });
const plan = await aiyoke.plan();
if (plan.operations.some((operation) => operation.kind === "conflict")) {
  throw new Error("Review conflicts before applying");
}
const result = await aiyoke.apply();
console.log(result.changedPaths);
```

### Engine methods

The returned engine is intentionally created through the facade rather than
exported as an eagerly loaded root value.

| Member | Contract |
| --- | --- |
| `root: string` | Canonical absolute workspace root. |
| `listExtensions()` | Deterministically sorted registered descriptors. |
| `detect()` | Positive language/framework detections sorted by confidence then ID. |
| `initialize(options?)` | Create `aiyoke.yaml`; preserve an existing file unless `force` is true. |
| `loadSpec()` | Parse and validate the current schema-v3 canonical source. |
| `configure(options?)` | Deterministically preview or edit project/root selections with backup-on-write. |
| `migrate(options?)` | Move through registered adjacent schemas; downgrade requires explicit consent. |
| `rollbackMigration(backup, options?)` | Validate and restore an Aiyoke backup, creating a safety backup first. |
| `plan()` | Return the complete read-only deterministic `HarnessPlan`. |
| `apply()` | Re-plan and atomically apply non-conflicting changes; return `{ plan, changedPaths }`. |
| `check()` | Return target, lock, ownership, and drift findings. |
| `doctor()` | Return `check()` findings plus missing-selection readiness diagnostics. |

Initialization options are optional `languages`, `frameworks`, `targetAdapters`,
and `force`. Selection arrays contain branded `ExtensionId` values. The result is
`{ path: "aiyoke.yaml", created, spec }`.

Configuration options are optional `name`, `architecture`, `languages`,
`frameworks`, `targetAdapters`, `packs`, and `dryRun`. The result contains
`changed`, `dryRun`, validated `spec`, canonical `output`, and an optional
`backupPath` only when a write needed a backup.

Migration options are optional `targetVersion`, `allowDowngrade`, and `dryRun`.
Migration/rollback results contain `operation`, `fromVersion`, `toVersion`,
`changed`, `dryRun`, applied steps, optional `backupPath`, and canonical `output`.

### `discoverSignedExtension(options)`

```ts
function discoverSignedExtension(
  options: SignedExtensionDiscoveryOptions
): Promise<SignedExtensionDiscoveryResult>;
```

The lazy Node adapter hashes a bounded package tree, parses a strict manifest,
verifies its Ed25519 signature against caller-owned offline trust/revocation
state, requires consent bound to the exact manifest digest, rechecks content
before import, and verifies the exported loader descriptor.

Required options are `manifestPath`, `packageRoot`, `trust`, and `consent`.
Optional `maxPackageBytes` and `maxPackageFiles` default to 32 MiB and 2,000.
The result is a discriminated union:

- `loaded`: includes `loader`, `manifest`, `manifestDigest`, and `contentDigest`;
- `consent-required`: includes the parsed manifest, digest, and signing key ID; or
- `rejected`: includes a bounded reason/message and optional manifest digest.

Never import the package yourself before a `loaded` result; that would bypass the
pre-import trust boundary.

```ts
import { discoverSignedExtension } from "aiyoke";

const result = await discoverSignedExtension({
  manifestPath: "vendor/example/aiyoke-extension.json",
  packageRoot: "vendor/example/package",
  trust,
  consent: { kind: "pending" }
});

switch (result.kind) {
  case "loaded":
    break;
  case "consent-required":
    console.log(`Review manifest ${result.manifestDigest}`);
    break;
  case "rejected":
    throw new Error(`${result.reason}: ${result.message}`);
}
```

### `renderSignedExtensionIsolated(options)`

```ts
function renderSignedExtensionIsolated(
  options: IsolatedSignedExtensionOptions
): Promise<IsolatedRendererResult>;
```

This verifies the signed package without importing it in the host, serializes a
bounded workspace snapshot, re-hashes/imports in a minimal child process, invokes
either `target-render` or `runtime-render`, and validates the returned artifact
set in both processes. `signal` cancels an active render.

Optional isolation limits and defaults:

| Limit | Default |
| --- | --- |
| `timeoutMs` | 5,000 |
| `maxInputBytes` | 16 MiB |
| `maxOutputBytes` | 2 MiB |
| `maxWorkspaceFiles` | 2,000 |
| `maxArtifacts` | 512 |
| `memoryMb` | 128 MiB V8 old-space setting |

The result is `rendered`, `consent-required`, or `rejected`. A rendered result
contains validated artifacts plus manifest/content identity. Child-process
isolation is defense in depth, not an operating-system sandbox.

### Root re-exports

The facade re-exports these runtime values without loading the engine:

| Values | Purpose |
| --- | --- |
| `AiyokeError` | Stable code/message/details error type. |
| `aggregateHarnessStack` | Union language/framework selections across single/monorepo composition. |
| `extensionId`, `safeRelativePath` | Validated branded IDs and generated paths. |
| `defineTarget`, `defineLanguage`, `defineFramework`, `definePack`, `defineRuntime` | Identity helpers preserving inferred extension types. |
| `EXTENSION_API_VERSION` | Current extension compatibility version (`1.0.0`). |
| `ExtensionRegistry` | Deterministic loader registration/resolution. |
| `runExtensionCompatibility` | Standalone public compatibility suite. |

Root-exported domain types are `ArtifactIntent`, `HarnessModule`, `HarnessPlan`,
`HarnessSpec`, `MonorepoWorkspace`, `PlanOperation`, `ProjectComposition`,
`RuntimeHarnessSpec`, `RuntimePolicy`, `TargetSpec`, and `VerificationFinding`.

Root-exported extension types are `AiyokeExtension`, `CapabilityPackExtension`,
`CompatibilityFixture`, `CompatibilityReport`, `CompatibilityRunOptions`,
`ExtensionDescriptor`, `ExtensionLoader`, `FrameworkExtension`,
`IsolatedRendererResult`, `IsolatedSignedExtensionOptions`, `LanguageExtension`,
`RuntimeTemplateExtension`, `SignedExtensionDiscoveryOptions`,
`SignedExtensionDiscoveryResult`, `SignedExtensionManifest`, and
`TargetExtension`.

Use the subpaths below for complete type families that are deliberately omitted
from the lightweight facade.

## `aiyoke/core`

The core subpath has no provider, framework, filesystem, process, or engine
dependency.

### Validation and deterministic values

| Export | Contract |
| --- | --- |
| `extensionId(value)` / `ExtensionId` | Validate and brand lower-case kebab-case IDs. |
| `safeRelativePath(value)` | Normalize separators and reject unsafe/cross-platform-invalid paths. |
| `canonicalJson(value)` | Serialize finite acyclic JSON with code-point-sorted object keys. |
| `compareCodePoints(left, right)` | Locale-independent Unicode code-point comparator. |
| `JsonPrimitive`, `JsonValue`, `JsonObject` | Read-only JSON domain types. |

### Errors

`AiyokeError` extends `Error` with `code: AiyokeErrorCode` and bounded JSON
`details`. Stable codes are:

```text
INVALID_SPEC, INVALID_PATH, EXTENSION_DUPLICATE, EXTENSION_MISSING,
EXTENSION_CONFLICT, EXTENSION_CYCLE, EXTENSION_API_MISMATCH,
REGISTRY_FROZEN, ARTIFACT_CONFLICT, PLAN_CONFLICT, WORKSPACE_IO,
VALIDATION_FAILED
```

Callers should branch on `code`, not message text.

### Configuration and runtime domain

The complete schema types are `ProjectArchitecture`, `ProjectIdentity`,
`HarnessStack`, `MonorepoWorkspace`, `ProjectComposition`, `HarnessSpec`, and
`GenerationPolicy`. Target types are `AgentFeature`, `CodingAgentTarget`,
`ChatPluginTarget`, `ApiProviderTarget`, `InferenceGatewayTarget`, `RoutePolicy`,
and `TargetSpec`.

Runtime policy exports are `RetryPolicy`, `CircuitBreakerPolicy`,
`FallbackPolicy`, `ReliabilityPolicy`, `ObservabilityPolicy`, `EvaluationPolicy`,
`SafetyPolicy`, `CachePolicy`, `TokenBudgetPolicy`, `CostBudgetPolicy`,
`PerformancePolicy`, `RuntimePolicy`, `RuntimeProfile`, and `RuntimeHarnessSpec`.
`DEFAULT_RUNTIME_HARNESS`, `PRODUCTION_RUNTIME_POLICY`, and
`resolveRuntimePolicy(profile)` expose the reviewed defaults described in the
[configuration reference](configuration.md#runtime).

### Compilation domain

Instruction/module types are `InstructionBlock`, `SkillDefinition`,
`HookDefinition`, `McpServerDefinition`, `SubagentDefinition`, and
`HarnessModule`. Artifact/plan types are `ArtifactOwnership`,
`ManagedSectionMarkers`, `ArtifactIntent`, `PlanOperation`, `HarnessPlan`,
`VerificationFinding`, and `HarnessLifecycle`.

`aggregateHarnessStack(composition)` returns unique selections in stable first
appearance order. It does not resolve registry dependencies.

## `aiyoke/extension-sdk`

The SDK depends only on core and is the supported surface for built-in and
third-party extensions.

### Extension contracts and helpers

`ExtensionKind` is `target | language | framework | pack | runtime`.
`ExtensionReference`, `ExtensionDescriptorBase`, and the discriminated
`ExtensionDescriptor` define identity, version, API version, capabilities,
requirements, conflicts, and runtime language ownership.

The SDK exports `WorkspaceSnapshot`, `DetectionResult`, `ContributionContext`,
`TargetRenderContext`, `TargetVerificationContext`, `RuntimeScope`, and
`RuntimeRenderContext`. Extension variants are `LanguageExtension`,
`FrameworkExtension`, `CapabilityPackExtension`, `TargetExtension`,
`RuntimeTemplateExtension`, and their union `AiyokeExtension`.

An `ExtensionLoader` exposes an eager descriptor and lazy `load()` function. The
loaded descriptor must be canonically identical to the advertised descriptor.
`defineLanguage`, `defineFramework`, `definePack`, `defineTarget`, and
`defineRuntime` preserve exact inferred types while checking the contract at
compile time.

### `ExtensionRegistry`

| Member | Contract |
| --- | --- |
| `register(loader)` | Register any API-compatible unique `(kind, id)` loader. |
| `registerTarget/Language/Framework/Pack/Runtime(loader)` | Kind-specific registration; runtime registration also enforces one owner per language. |
| `freeze()` | Validate the dependency graph and reject subsequent registration. |
| `frozen` | Current registration state. |
| `list(kind?)` | Deterministically sorted loaders, optionally filtered by kind. |
| `has(reference)` | Test exact `(kind, id)` registration. |
| `get(reference)` | Lazy-load once and verify descriptor identity. |
| `resolve(references)` | Resolve requirements, reject conflicts/cycles/missing loaders, and lazy-load in deterministic dependency order. |
| `reference(kind, id)` | Construct an `ExtensionReference`. |

### Compatibility kit

`runExtensionCompatibility(options)` checks descriptor/API shape, dependencies,
loader identity, typed execution, deterministic repeatability, artifact safety,
output bounds, and secret canaries. Exports include `CompatibilityCheckId`,
`CompatibilityCheck`, `CompatibilityFinding`, `CompatibilityFixture`,
`CompatibilityRunOptions`, and the `passed | failed` `CompatibilityReport`.

```ts
import { runExtensionCompatibility } from "aiyoke/extension-sdk";

const report = await runExtensionCompatibility({ loader, dependencies, fixture });
if (report.kind === "failed") {
  throw new Error(JSON.stringify(report.findings));
}
```

### Signed manifests and trust

The SDK exports `SignedExtensionManifest`, `ExtensionTrustRoot`,
`ExtensionTrustStore`, `ExtensionConsent`, `ManifestCryptoPort`,
`ManifestRejectionReason`, `ManifestVerificationResult`,
`SignedExtensionDiscoveryOptions`, `VerifiedSignedExtensionPackage`,
`SignedExtensionPackageVerificationResult`, and
`SignedExtensionDiscoveryResult`.

`parseSignedExtensionManifest(source)` strictly parses a maximum 64 KiB JSON
manifest. `manifestSigningPayload(manifest)` returns canonical unsigned content.
`verifySignedExtensionManifest(manifest, actualContentDigest, trust, consent,
crypto)` performs pure cryptographic/trust/consent verification without package
I/O. Node package hashing and importing remain behind the root lazy facade.

### Renderer isolation contracts

Exports are `RENDERER_ISOLATION_PROTOCOL_VERSION`, `IsolatedRenderInvocation`,
`RendererIsolationLimits`, `IsolatedSignedExtensionOptions`,
`RendererIsolationRejectionReason`, and `IsolatedRendererResult`. These are wire
and result contracts; process creation remains behind
`renderSignedExtensionIsolated()`.

### Runtime capability manifests

`RUNTIME_CAPABILITY_FAMILY_IDS` is the exact ordered seven-family set. The SDK
exports `RuntimeCapabilityFamilyId`, `ImplementedCapabilityComponent`,
`IntegrationPortCapabilityComponent`, `RuntimeCapabilityFamily`,
`RuntimeCapabilityManifest`, and `RuntimeCapabilityValidationContext`.

`validateRuntimeCapabilityManifest(value, context)` requires every family in
order, exactly one implemented and one integration-port component per family,
canonical safe artifact paths, non-empty unique behaviors/contracts, and
acceptance artifacts present in the caller's executed set.

## Compatibility and errors

Public functions reject invalid caller arguments with `AiyokeError` where the
error crosses the application domain and `TypeError`/`RangeError` for pure SDK
parsing/validation contracts. Discovery and isolation convert hostile package or
renderer failures into discriminated bounded rejections. Never depend on
renderer-controlled exception text.

Extension API compatibility is explicit through `EXTENSION_API_VERSION`. A
breaking SDK contract requires a new API version and migration notes; it is not
introduced as a silent structural change. See [Extension authoring](extensions.md)
for complete package, signing, compatibility, and isolation workflows.
