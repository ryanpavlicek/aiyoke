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
| Supported language/framework rendering | Proven | The representative single-stack matrix plus the 12-workspace polyglot monorepo suite cover all five languages, every framework family, nested/conflicting evidence, deterministic operation order, drift verification, and idempotence. |
| Schema lifecycle | Proven | Schemas v1 through v3, adjacent reversible registry steps, dry-run, explicit downgrade consent, content-addressed backups, rollback, corruption tests, and lossy-downgrade refusal are covered in unit and integration suites. |
| Configuration editing | Proven | `aiyoke config` supports deterministic flags, dry-run, and explicit TTY-only interaction; confirmation, cancellation, invalid input, validation, backup, and no-write behavior are tested. |
| Extension compatibility | Proven | The public `runExtensionCompatibility()` kit validates descriptors/API versions, dependency graphs, loader identity, typed execution, deterministic repeatability, normalized safe artifacts, output bounds, LF content, and secret canaries without importing engine internals. Adversarial fixtures cover hostile loaders and renderers. |
| Signed extension discovery | Proven | The lazy Node adapter performs strict bounded manifest parsing, deterministic package-tree hashing, Ed25519 verification, offline trust roots, key/content/manifest revocation, digest-bound explicit consent, a second pre-import content check, symlink rejection, and exact exported-descriptor verification. Adversarial tests prove rejection before import, and the external hello target completes the signed flow. |
| Renderer isolation | Partial | The optional lazy adapter verifies without host import, re-hashes in a minimal-environment child, uses a versioned IPC protocol, bounds input/output/files/artifacts/V8 heap, supports deadlines and cancellation, ignores stdout, and validates results in both processes. Hostile renderer tests pass on Windows; Linux and packaged-artifact CI evidence is pending. |
| Adversarial and property testing | Proven | Seeded fast-check suites cover single/monorepo configuration round trips, ASCII/Unicode platform paths, parser limits, aliases, duplicates, and hostile shapes. Compatibility fixtures contain malicious loaders, nondeterministic/oversized/unsafe output, duplicate ownership, secret leakage, and invalid detection. Generated runtimes cover deadlines, cancellation, panics/exceptions, malformed output, and response limits. A deterministic filesystem race harness swaps a verified ancestor for a symlink both before staging and before rename, proving fail-closed containment without an outside target write. |
| CI | Partial | The workflow now separates static, six-platform Node 22/24 test/build/isolation, coverage, exact-package install, production audit, dependency review, native-runtime, and framework-runtime jobs. Local gates pass; the expanded hosted workflow has not completed yet. |
| Distribution and rollback | Partial | A local exact-tar content/import/CLI/install gate passes. The tag workflow validates version metadata, builds once, verifies the exact tarball, creates checksums and an SPDX SBOM, emits GitHub attestations, and publishes through npm OIDC behind the protected `npm` environment. Hosted execution, npm trusted-publisher/environment configuration, upgrade rehearsal, and a real release remain pending. |
| Public documentation | Partial | Architecture, configuration/migration, compatibility, runtime boundary, signed extensions/isolation, security threat model, and release/rollback operations are documented. README installation, tutorials, command/API reference, recipes, and troubleshooting still need expansion. |
| Production runtime templates | Partial | All five registered templates generate a standard-library execution facade with adapter/guard registries, typed lifecycle state, deadlines/cancellation, retry/fallback/circuit breaking, validation/repair, redacted events, approval, cache/evaluation ports, budgets, and bounded batch concurrency. Registered tooling modules add validation, approval, deadlines/cancellation, redacted events, and exception/panic containment. Registered evaluation modules add versioned offline/sampled suites, bounded concurrency, reproducibility metadata, report/feedback ports, and regression decisions. Generated native suites pass Node, TypeScript, Python, Go, and Rust compiler/formatter gates. Framework adapters compile/import against pinned real dependencies. Registered OpenRouter/xAI Responses adapters include native malformed/oversized-response tests in every language; Rust uses the documented typed transport port. An explicit opt-in command exercises a generated adapter against OpenRouter without exposing credentials or outputs. The remaining contract matrix is still open. |

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

Current evidence for gates 1 and 2: commit `bcf12ed` passed GitHub CI on Node 22
and 24 after a 96-test local gate. The schema-v3 runtime facade and generated
native suites passed Node, TypeScript, Python, Go, and Rust validation in GitHub
Actions run `29521118163`; the work remains unreleased until every gate below is
proven. Framework adapter dependency compatibility passed in run `29522313151`.
Registered tool and evaluation modules passed native formatter, compiler/type
checker, behavior, cancellation, and panic/exception containment gates in run
`29526999932`.
Bounded provider-response and malformed-payload tests passed every native and
framework CI job in run `29527429291`. The opt-in live fixture subsequently
completed one environment-injected OpenRouter request without logging its secret,
prompt, or output.
The public compatibility-kit suite and the full polyglot monorepo framework
matrix are part of `pnpm check`; the focused six-test gate also proves hostile
loader containment, deterministic planning, nested conflicting detection
evidence, complete framework integration rendering, and second-apply idempotence.
That tranche passed the complete Linux Node 22/24, native-runtime, and
framework-runtime workflow in GitHub Actions run `29528657917`.
Signed extension discovery is now implemented behind the public lazy facade with
the trust store, consent decision, and cryptography expressed as downward-facing
contracts. Its focused adversarial suite covers tampering, invalid signatures,
unknown and revoked keys, content and manifest revocation, mismatched consent,
descriptor substitution, strict parsing, resource bounds, and package symlinks.
The repository also contains a complete external hello target that passes the
public compatibility kit, is signed with an ephemeral test key, and renders
through the child-process adapter. Isolation tests cover secret-environment
non-inheritance, the applied heap argument, stdout noise, timeouts, cancellation,
input/output limits, and unsafe artifact paths.
A deterministic atomic-write test seam now forces ancestor symlink substitution
after directory verification and after temporary-file staging. The Node adapter
canonicalizes the root, binds the staged file to the verified real parent, and
revalidates that parent before rename; both interleavings reject without creating
the requested path outside the workspace.

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
