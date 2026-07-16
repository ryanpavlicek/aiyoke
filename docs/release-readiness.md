# Public release readiness

Version 0.3 is Aiyoke's first public-ready release. A roadmap item is complete
only when a reproducible test, workflow run, packaged artifact, or reviewed
document proves it. Intent, an implementation without tests, and a green test
that does not cover the stated scope are not completion evidence.

## Status legend

| Status | Meaning |
| --- | --- |
| Proven | The repository contains direct, reproducible evidence for the full gate. |
| Partial | Useful implementation or evidence exists, but the gate is not fully covered. |
| Missing | No adequate implementation or evidence exists yet. |

## Baseline audit

| Area | Current status | Evidence or gap |
| --- | --- | --- |
| Layered dependency direction | Proven | `scripts/check-architecture.mjs` runs in `pnpm check` and CI. |
| Registry-based built-ins and lazy facade | Proven | Registry and lazy-facade unit/integration tests cover built-ins and injected loaders. |
| Deterministic planning and atomic application | Proven | Compiler, filesystem, integration, and five-stack dogfood tests cover the 0.1 contract. |
| Supported target rendering | Partial | Renderer tests and manual Claude/Grok/OpenRouter checks exist; reproducible client-version fixtures are still missing. |
| Supported language/framework rendering | Partial | Representative single-stack fixtures exist; polyglot and monorepo composition are missing. |
| Schema lifecycle | Proven | Schema v2, adjacent reversible registry steps, dry-run, explicit downgrade consent, content-addressed backups, rollback, corruption tests, and lossy-downgrade refusal are covered in unit and integration suites. |
| Configuration editing | Proven | `aiyoke config` supports deterministic flags, dry-run, and explicit TTY-only interaction; confirmation, cancellation, invalid input, validation, backup, and no-write behavior are tested. |
| Extension compatibility | Partial | In-process registration is tested; no distributable fixture suite or compatibility command exists. |
| Signed extension discovery | Missing | External loaders must be supplied programmatically and have no signed manifest or trust policy. |
| Renderer isolation | Missing | Third-party renderers execute in-process with the host's authority. |
| Adversarial and property testing | Partial | Focused unsafe-path and malformed-input cases exist; generative and malicious extension suites are missing. |
| CI | Partial | Linux and Node 22/24 run the full check; Windows, macOS, packaging, security, and release jobs are missing. |
| Distribution and rollback | Missing | No publish workflow, provenance, package smoke test, SBOM, upgrade test, or rollback procedure exists. |
| Public documentation | Partial | Architecture and extension notes exist; README installation, tutorials, recipes, API reference, troubleshooting, and release operations are incomplete. |
| Production runtime templates | Missing | Generated artifacts configure developer agents and provider routes, but do not yet supply executable reliability, observability, evaluation, safety, or cost-control primitives. |

## 0.2 release gates

1. A versioned migration registry upgrades every supported historical schema one
   step at a time, refuses gaps and downgrades by default, creates a recoverable
   backup, supports dry-run output, and is covered by rollback and corruption tests.
2. `aiyoke config` offers deterministic non-interactive flags and a TTY-only
   interactive flow. Cancellation and invalid input never modify the source file.
3. Polyglot monorepo fixtures cover every supported language and framework family,
   nested manifests, conflicting evidence, deterministic ordering, and idempotence.
4. A standalone extension compatibility runner verifies API versioning, loader
   identity, dependency graphs, deterministic output, safe paths, secret handling,
   and repeatability without requiring access to private engine internals.
5. Property-based and adversarial suites exercise parser limits, Unicode and
   platform paths, symlink races, managed markers, duplicate ownership, dependency
   cycles, hostile settings, and extension failures with reproducible seeds.
6. A provider-neutral runtime-harness domain model and extension contracts cover
   typed model requests, responses, failures, policies, lifecycle state, and
   registration points without adding provider branches to the core.

Current local evidence for gates 1 and 2: `pnpm check` passes 96 tests with
91.34% statement coverage on Node 24, including migration registry, schema,
engine, CLI, property-based, and adversarial suites. Cross-platform CI evidence
is still required before the gates are considered release-final.

## 0.3 release gates

1. Third-party extensions are discovered through a registry adapter rather than
   core branching. Every installable manifest is content-addressed and signed;
   trust roots, revocation, offline verification, and explicit user consent are
   documented and tested.
2. Optional renderer isolation uses a bounded child process with a versioned
   message protocol, time/output/memory limits where the platform supports them,
   a minimal environment, cancellation, and fail-closed result validation.
3. Maintainers can run a published compatibility kit against extension packages.
   At least one complete external target or pack example passes it in CI.
4. CI runs supported Node versions on Linux, Windows, and macOS. Separate jobs
   validate formatting, types, architecture, tests, coverage, package contents,
   installation, CLI smoke behavior, dependency security, and generated artifacts.
5. Tagged releases build once, verify the exact package, publish with provenance,
   create checksummed release assets and an SBOM, and have a tested rollback and
   deprecation procedure. Publishing requires a protected environment.
6. README and supporting docs cover installation, five-minute setup, concepts,
   all commands, configuration, extension authoring, security, troubleshooting,
   upgrades, migrations, rollback, compatibility policy, and complete examples.
7. Reproducible validation covers Claude Code, ChatGPT/Codex, Grok/Grok Build,
   OpenRouter, and every promised Python, TypeScript, JavaScript, Rust, and Go
   framework integration. Credentials remain environment-only and logs are checked
   for accidental disclosure.
8. Generated runtime templates satisfy every acceptance criterion in
   `docs/runtime-harness-contract.md`: reliability, observability, evaluation,
   safety, developer consistency, provider portability, and cost/performance.
   Each supported language has executable tests, while framework adapters prove
   request lifecycle integration without duplicating the runtime core.

## Public release decision

The 0.3 release candidate may be tagged only when every 0.2 and 0.3 gate is
Proven, `pnpm check` and all release workflows pass from a clean clone, the packed
tarball is the artifact tested in installation jobs, and no unresolved critical
or high-severity security finding remains. Any exception must be documented as a
time-bounded release blocker, not silently reclassified as future work.
