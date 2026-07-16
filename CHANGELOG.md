# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Schema version 2 with discriminated single-project and monorepo composition.
- Schema version 3 with enabled/disabled runtime state, production or fully
  composed custom policies, and a reversible 2-to-3 migration.
- A registry-driven, reversible schema migration lifecycle with dry-run,
  explicit downgrade consent, content-addressed backups, and atomic rollback.
- Deterministic `config` flags and a confirmation-gated TTY-only interactive
  editor that preserve the source on cancellation or invalid input.
- Property-based and adversarial configuration suites covering round trips,
  paths, parser resource limits, aliases, duplicate fields, and hostile shapes.
- Evidence-based 0.3 release gates and a production runtime-harness contract.
- Registered provider-neutral runtime template extensions for Python,
  TypeScript, JavaScript, Rust, and Go, with registered adapters and guards,
  typed lifecycle results, deadlines and cancellation, retry/fallback/circuit
  breaking, structured-output validation and repair, redacted events, approval,
  cache and evaluation ports, budgets, bounded concurrency, resolved policy
  files, and native conformance tests.
- Registered thin runtime request adapters for every supported framework, with a
  clean CI fixture that compiles or imports them against pinned real framework
  releases.
- Added registered OpenRouter and xAI Responses API runtime adapters for all five
  languages, injected secret and HTTP boundaries, native mock conformance tests,
  cost/usage mapping, retry classification, endpoint validation, and credential
  redaction. Rust deliberately uses a typed transport port rather than choosing
  an application TLS crate.
- Registered native tooling and evaluation modules for all five languages,
  including typed tool registries, validation, approval, cancellation/deadlines,
  redacted events, versioned offline and sampled-online suites, bounded
  concurrency, reproducibility metadata, baseline regression decisions, report
  sinks, human feedback, and adversarial exception/panic containment tests.
- Bounded provider-response readers and malformed JSON failures across every
  Responses adapter, plus a credential-safe opt-in OpenRouter live smoke fixture.
- A public extension compatibility kit with deterministic double execution,
  dependency/identity validation, output/path limits, and secret-canary checks.
- A 12-workspace polyglot monorepo acceptance suite covering every supported
  language and framework integration, nested conflicting evidence, deterministic
  plans, drift checks, and idempotent apply behavior.
- Property coverage for monorepo serialization and safe Unicode path components,
  including canonical workspace field ordering independent of object construction.
- Signed third-party extension discovery through the lazy public facade, with a
  strict versioned manifest, deterministic content-tree digests, Ed25519 trust
  roots, key/content/manifest revocation, exact-digest consent, resource limits,
  symlink rejection, revalidation before import, and adversarial tests.
- Optional target/runtime renderer isolation using a versioned child-process
  protocol, bounded snapshots and outputs, heap/deadline/cancellation controls,
  a minimal environment, package re-hashing, and fail-closed artifact validation.
- A complete external hello-target template that passes the public compatibility
  kit and signed isolated-rendering flow with ephemeral CI trust material.
- Canonical workspace roots and fail-closed atomic-write parent binding, with a
  deterministic adversarial harness for symlink substitution before staging and
  before rename.
- Cross-platform Node 22/24 CI with separate static, coverage, package, security,
  dependency-review, native-runtime, and framework-runtime gates.
- Exact npm tarball content/install/import/CLI validation and a protected OIDC
  release workflow with checksums, SPDX SBOM, GitHub attestations, npm provenance,
  immutable release assets, and documented deprecation/rollback operations.
- Public product documentation with installation and five-minute setup, complete
  CLI/public-API references, concepts, extension security, troubleshooting,
  migration/recovery, release operations, and explicit hosted-service boundaries.
- Strict target artifact contracts plus exact Claude Code and Codex CLI probes and
  SHA-256-pinned Grok Build inspection. ChatGPT manifests, marketplaces, hooks,
  MCP endpoints, portable tool aliases, and read-only Claude subagents now render
  directly into their documented native client shapes.
- Real-framework request lifecycle fixtures for every supported adapter, including
  authorization propagation, typed HTTP failures, disconnect cancellation and
  exception forwarding. Python supplies an asynchronous cancellation-probe port;
  Rust request factories supply typed execution options for cancellation injection.
- Terminal cancellation, guard, approval, and budget failures now stop routing in
  every generated runtime, preventing fallback providers from bypassing policy or
  replacing the original failure category.
- Cache hits, misses, stores, and read/write failures are observable across every
  generated runtime. Cache, evaluation, guard, and approval integration failures
  are contained; policy dependencies fail closed while storage dependencies
  degrade without corrupting a successful model result.
- Machine-readable `capabilities.json` output for every language, with composed
  implemented and integration-port variants for all seven production families,
  plus exact template and native acceptance artifact references.

## 0.1.0 — 2026-07-16

### Added

- Deterministic `init`, read-only `plan`, atomic/idempotent `apply`, `check`,
  `doctor`, `detect`, and `list` commands.
- Native target adapters for Claude Code, Codex, ChatGPT plugins, Grok Build,
  xAI/Grok API configuration, and OpenRouter routing.
- Registered language extensions for Python, TypeScript, JavaScript, Rust, and
  Go, with first-party modern framework extensions.
- Layered architecture enforcement, a lazy public facade, a versioned extension
  SDK, dependency-aware registry, and additional-extension injection.
- Content-addressed lock manifests, generated-artifact drift detection,
  ownership conflicts, stale-plan protection, atomic writes, and cross-platform
  path validation.
- CI for Node.js 22 and 24, governance files, ADRs, extension documentation, and
  the first-release acceptance suite.
- A five-stack dogfood matrix that exercises all six AI target surfaces for
  Python/FastAPI, TypeScript/Next.js, JavaScript/Express, Rust/Axum, and Go/Gin.
- Selective `init --targets` profiles and bounded managed-section merging that
  preserves user-authored content around generated instructions.
- Grok Build artifacts validated against the official CLI, including native
  `AGENTS.md`, `.grok/skills`, hook JSON, and project-scoped MCP TOML formats.
