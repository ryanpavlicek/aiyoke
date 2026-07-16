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
