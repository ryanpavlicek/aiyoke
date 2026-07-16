# Architecture

`aiyoke` is a TypeScript, single-package compiler. It keeps one canonical,
target-neutral harness specification and projects that specification into native
artifacts for each registered target. The design favours deterministic output,
small public entry points, and extension registration over target-specific
conditionals in the domain core.

## Source layers

The dependency direction is inward and downward. A layer can use the layers in
its row (and external packages), but it must not reach around the boundary.

| Layer | Location | Responsibility | May import |
| --- | --- | --- | --- |
| Core | `src/core` | Value objects, discriminated unions, errors, JSON-safe domain types | Core only |
| Extension SDK | `src/extension-sdk` | Stable extension contracts, descriptors, registry, lifecycle hooks | Core and the SDK |
| Application | `src/application` | Discover, resolve, plan, apply, and verify use cases | Core, SDK, and application |
| Infrastructure | `src/infrastructure` | Filesystem, configuration, hashing, and other replaceable adapters | Core, SDK, application, and infrastructure; never interfaces |
| Engine | `src/engine` | Composition/facade that wires application, infrastructure, and lazy extension loaders | Core, SDK, application, infrastructure, engine, and extension implementations when composition requires it; never interfaces |
| Interfaces | `src/interfaces` | CLI and other user-facing adapters | Lower layers and interfaces |
| Extensions | `src/extensions` | First-party and third-party targets, languages, frameworks, packs, and runtimes | Core, SDK, `extensions/shared`, and files in the same extension category; extensions should not import application, infrastructure, or interfaces |

`src/extensions/shared` is deliberately small. It contains reusable extension
helpers, not application services. Extension categories (`targets`, `languages`,
`frameworks`, `packs`, and `runtimes`) should communicate through SDK contracts and registry
metadata rather than importing one another.

The repository runs `scripts/check-architecture.mjs` in `pnpm check`. The check
resolves local static imports and fails on a forbidden edge. Dynamic imports are
the explicit lazy-loading boundary and are not treated as static edges.

## Canonical source and lifecycle

The version-3 project specification is the source of truth. Its composition is
a discriminated union: a single project owns one stack, while a monorepo owns a
root stack plus identified, path-bound workspace stacks. The compiler aggregates
registered extensions across that composition without adding language or
framework conditionals to the core. Generated target files are
projections, never a second configuration database. A normal run follows this
pipeline:

1. **Discover** reads the canonical spec and observes the workspace.
2. **Resolve** selects extensions, validates versions/dependencies/conflicts,
   and produces a stable module order.
3. **Plan** computes a deterministic, fingerprinted set of artifact operations.
4. **Apply** writes only owned artifacts (or marked managed sections), using
   atomic replacement, a canonical workspace root, safe relative paths, and
   real-parent identity checks before staging and rename.
5. **Verify** checks generated artifacts and target-specific invariants.

Enabled application-plane runtimes use the same rule. The compiler resolves one
`RuntimeTemplateExtension` per selected language and invokes it for the root or
workspace scope. Runtime extensions generate provider-neutral source and resolved
policy artifacts; provider, telemetry, cache, safety, approval, and evaluation
services remain registered ports outside the core.

Schema evolution is a separate, explicit lifecycle. Adjacent reversible steps
are registered in `SchemaMigrationRegistry`; normal loading never silently
upgrades a document. Migration validates the complete destination before writing,
creates a content-addressed backup, rechecks the source, and atomically replaces
it. Downgrades require explicit consent and lossy transformations fail closed.

The lifecycle is represented by discriminated unions in `src/core/model.ts`.
Each stage is pure where possible; filesystem and process effects live in
infrastructure adapters. Plans are idempotent: planning twice without a source
change yields the same fingerprint and operations in the same order.

## Registry and composition

Capabilities are added through `ExtensionRegistry`. Registration validates a
unique `(kind, id)` key and the SDK API version. `freeze()` validates required
extensions and dependency cycles before a run. Resolution sorts roots and
performs a deterministic dependency-first traversal; conflicts are rejected
before any artifact is written.

The engine owns composition, not the core. It may register built-ins and load
optional extensions lazily, but the core must never switch on a target,
framework, or host. Adding a target means implementing its SDK descriptor,
rendering, and verification behavior, then registering a loader.

## Public API and lazy loading

`src/index.ts` is intentionally lightweight. It exports stable core types and
SDK contracts and dynamically loads the engine/facade for operations that need
filesystem, configuration, or extension implementations. This keeps importing
the package safe in tooling and allows consumers to use type-level contracts
without eagerly loading every adapter.

The CLI entry point follows the same rule: command parsing and interface code
may be loaded eagerly, while expensive engine work is deferred until a command
actually runs. Public exports must not statically import infrastructure,
engine, interfaces, or extension implementations.

## Trust and secrets

An extension is executable code. Treat extension packages, hooks, MCP commands,
and generated scripts as code: review their source, pin versions, and run them
only in trusted workspaces. The registry validates metadata and dependencies but
is not a sandbox. Signed discovery adds integrity, publisher trust, revocation,
and explicit consent. Optional renderer isolation reduces host-process authority
but is not an OS sandbox; genuinely untrusted code still requires a container,
VM, or equivalent platform policy.

Secrets are never copied into generated artifacts. Providers refer to
environment-variable names (for example, `OPENROUTER_API_KEY`), and generated
adapters receive values only from a secret resolver injected by the consuming
application at execution time. Plans and logs must redact token values and
should record the variable name or provider identifier instead.

OpenRouter is supported behind an explicit inference-gateway domain boundary.
Its generated configuration contract is versioned, while external routing,
model availability, and upstream error semantics remain provider-controlled.
Verification surfaces invalid routing configuration as a finding rather than
silently changing the canonical specification.

## Invariants

- Paths entering generation are validated as safe, relative paths.
- Atomic writes bind their staged file to the verified real parent and recheck
  that parent before rename; ancestor symlink substitution fails closed.
- Artifact ownership is explicit (`generated`, `managed-section`, or
  `user-owned`); user-owned content is never overwritten without a managed
  marker.
- Duplicate extension IDs, missing requirements, cycles, and conflicting
  artifact owners fail before writes.
- Ordering is explicit and stable; no output depends on filesystem enumeration
  order or object key insertion order.
- Generated files contain no secret values.

See [Extension authoring](extensions.md) for the SDK contract and [the ADRs](adr/)
for decisions that constrain future changes.
