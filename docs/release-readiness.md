# Public release readiness

Version 0.3 made Aiyoke public-ready; 0.4 is a focused enforcement and
cross-language contract hardening release. A roadmap item is complete only when
a reproducible test, workflow run, packaged artifact, or reviewed document proves
it. Intent, an implementation without tests, and a green test that does not cover
the stated scope are not completion evidence.

## Status legend

| Status | Meaning |
| --- | --- |
| Proven | The repository contains direct, reproducible evidence for the full gate. |
| Partial | Useful implementation or evidence exists, but the gate is not fully covered. |
| Missing | No adequate implementation or evidence exists yet. |

## 0.4 focused hardening gates

| Gate | Status | Reproducible evidence |
| --- | --- | --- |
| Cross-language runtime contract | Proven | `conformance.json` drives native option, provider, guard-stage, sync-exception, and response-wire assertions in all five languages; `pnpm test:runtimes` formats, compiles, and executes them. JavaScript runtime/provider/module/framework templates are generated from TypeScript and byte-checked by `pnpm check:runtime-js`. |
| Artifact and renderer boundary | Proven | Compiler, filesystem, discovery, and isolation adversarial suites reject reserved destinations, secret/dependency snapshots, excessive outputs, malformed artifacts, symlink substitutions, and stale package identity. Timeout tests prove termination escalation, while opt-in diagnostics remain sanitized. |
| Architecture and extension ambiguity | Proven | The AST gate rejects upward, bare, and unauthorized dynamic imports. Module-conflict tests reject duplicate skill, subagent, hook, and MCP namespaces; hostile frontmatter fixtures remain valid YAML. |
| Deterministic application | Proven | Compiler and real-filesystem tests cover LF/CRLF content, stable fingerprints, full-batch staging, stale revalidation, rollback-capable commit, zero partial output on staging failure, and idempotent second apply. |
| Configuration and public API | Proven | Parser/CLI tests aggregate positioned issues, unknown commands have no filesystem side effect, loader meta-tests pin one export convention, package/type gates name `AiyokeEngine`, and docs catalog every diagnostic contract. |
| Regression resistance | Proven | Property suites use pinned seed `169279552`; focused adversarial, native runtime, real framework, target-client, package, coverage, architecture, documentation, and six-platform Node gates remain required by CI. |

## Baseline audit

| Area | Current status | Evidence or gap |
| --- | --- | --- |
| Layered dependency direction | Proven | `scripts/check-architecture.mjs` rejects upward, bare, and unauthorized dynamic imports in `pnpm check` and CI. |
| Registry-based built-ins and lazy facade | Proven | Registry and lazy-facade unit/integration tests cover built-ins and injected loaders. |
| Deterministic planning and atomic application | Proven | Compiler, filesystem, integration, and five-stack dogfood tests cover deterministic LF/CRLF plans and rollback-capable multi-file application. |
| Supported target rendering | Proven | Strict artifact-contract fixtures cover every supported target, environment-only credentials, native hook/MCP/plugin/marketplace shapes, and secret canaries. Exact Claude Code and Codex npm CLIs plus SHA-256-pinned Grok Build binaries pass locally and in [CI run 29534732991](https://github.com/ryanpavlicek/aiyoke/actions/runs/29534732991): Claude parses the MCP entry, Codex validates and discovers the ChatGPT marketplace, and Grok `inspect --json` discovers instructions, skills, and the MCP endpoint. Provider targets expose tested OpenRouter and xAI endpoints and credential ports. |
| Supported language/framework rendering | Proven | The representative single-stack matrix plus the 12-workspace polyglot monorepo suite cover all five languages, every framework family, nested/conflicting evidence, deterministic operation order, drift verification, and idempotence. Real-dependency request lifecycle fixtures exercise authorization, invalid requests, typed errors, exception forwarding, and cancellation for every adapter; the full TypeScript, JavaScript, Python, Go, and Rust gate passed in [CI run 29536646599](https://github.com/ryanpavlicek/aiyoke/actions/runs/29536646599). |
| Schema lifecycle | Proven | Schemas v1 through v3, adjacent reversible registry steps, dry-run, explicit downgrade consent, content-addressed backups, rollback, corruption tests, and lossy-downgrade refusal are covered in unit and integration suites. |
| Configuration editing | Proven | `aiyoke config` supports deterministic flags, dry-run, and explicit TTY-only interaction; confirmation, cancellation, invalid input, validation, backup, and no-write behavior are tested. |
| Extension compatibility | Proven | The public `runExtensionCompatibility()` kit validates descriptors/API versions, dependency graphs, loader identity, typed execution, deterministic repeatability, normalized safe artifacts, output bounds, LF content, and secret canaries without importing engine internals. Adversarial fixtures cover hostile loaders and renderers. |
| Signed extension discovery | Proven | The lazy Node adapter performs strict bounded manifest parsing, deterministic package-tree hashing, Ed25519 verification, offline trust roots, key/content/manifest revocation, digest-bound explicit consent, a second pre-import content check, symlink rejection, and exact exported-descriptor verification. Adversarial tests prove rejection before import, and the external hello target completes the signed flow. |
| Renderer isolation | Proven | The optional lazy adapter verifies without host import, re-hashes in a minimal-environment child, uses a versioned IPC protocol, bounds input/output/files/artifacts/V8 heap, supports deadlines and cancellation, ignores stdout, and validates results in both processes. Hostile tests and the compiled-artifact smoke pass across Linux, Windows, macOS, and Node 22/24. |
| Adversarial and property testing | Proven | Seeded fast-check suites cover single/monorepo configuration round trips, ASCII/Unicode platform paths, parser limits, aliases, duplicates, and hostile shapes. Critical artifact properties are explicit: generated paths never escape the workspace; managed-section merges preserve arbitrary user-owned prefix/suffix text and reject malformed markers; and plan fingerprints remain stable when equivalent inputs are reordered while a second apply is a zero-write operation. Compatibility fixtures contain malicious loaders, nondeterministic/oversized/unsafe output, duplicate ownership, secret leakage, and invalid detection. Generated runtimes cover deadlines, cancellation, panics/exceptions, malformed output, and response limits. A deterministic filesystem race harness swaps a verified ancestor for a symlink both before staging and before rename, proving fail-closed containment without an outside target write. |
| CI | Proven | [Run 29537564578](https://github.com/ryanpavlicek/aiyoke/actions/runs/29537564578) passed separate static, six-platform Node 22/24 test/build/isolation, coverage, exact npm-package install/import/CLI, production audit, pinned target-client, native-runtime, and real-framework jobs. Dependency review is configured for pull requests and intentionally skipped on pushes. |
| Distribution and rollback | Proven | [GitHub release v0.3.3](https://github.com/ryanpavlicek/aiyoke/releases/tag/v0.3.3) and npm `aiyoke@0.3.3` are public. The protected tag workflow validates version metadata, builds once, verifies the exact tarball, creates checksums and an SPDX SBOM, emits GitHub attestations, and publishes through npm OIDC. The package gate independently runs publint, ESM type-resolution lint, content checks, and clean install/import/CLI smoke tests; deprecation and rollback procedures are documented. |
| Public documentation | Proven | README leads with the problem, a 60-second before/after, Simple Mode, product boundary, installation, five-minute setup, concepts, support, workflow, configuration, commands, recovery, providers, extensions, architecture, troubleshooting, development, and security. Supporting docs provide complete CLI/API references, the [public error and finding catalog](errors-and-findings.md), compatibility, configuration/migrations, extension signing/isolation and a prominent trust/deployment model, runtime acceptance, release/rollback operations, examples, and a security threat model. |
| Production runtime templates | Proven | All five registered templates generate a standard-library execution facade with adapter/guard registries, typed lifecycle state, deadlines/cancellation, retry/fallback/circuit breaking, validation/repair, redacted events, approval, cache/evaluation ports, budgets, and bounded batch concurrency. Terminal policy failures cannot fall through to fallback routes. Cache/evaluation failures degrade safely while guard/approval failures fail closed. Tooling/evaluation modules provide guarded execution, reproducible suites, report/feedback ports, and regression decisions. OpenRouter/xAI adapters reject malformed and oversized responses; Rust uses a typed transport port. The closed manifest validator proves all seven family entries, implementation/port delivery variants, safe non-placeholder templates, and acceptance artifacts executed by the native job. Explicit timeout-versus-cancellation, cache-boundary, policy, routing, observability, evaluation, cost, and concurrency cases passed every language formatter/compiler/test gate in [CI run 29537564578](https://github.com/ryanpavlicek/aiyoke/actions/runs/29537564578). Adoption bake-in adds eight deterministic 32-request pressure rounds (256 requests per runtime), event-cardinality/redaction, resource/concurrency saturation, and cost-budget fail-closed assertions across all five generated language runtimes; TypeScript, JavaScript, and Python additionally exercise deterministic circuit-open/half-open pressure. These are bounded correctness tests, not soak/load benchmarks; sustained production-load evidence remains a follow-on gate. |

## Critical property-test contract

The property suite is intentionally organized around invariants that protect
generated repositories, rather than only around parser examples:

| Critical path | Property that must hold | Adversarial companion |
| --- | --- | --- |
| Path safety | Every accepted generated path is normalized, relative, contained by the workspace, and stable across platform separators and Unicode. | Traversal, absolute paths, symlink ancestors, non-directory ancestors, and a race that swaps a verified parent are rejected before an outside write. |
| Managed-section merging | For arbitrary user-owned prefix/suffix text, replacing a bounded managed section changes only bytes between its markers; a missing, duplicated, or out-of-order marker is a conflict. | Legacy markers, marker text inside generated content, CRLF input, and user-owned whole files never get silently replaced. |
| Plan fingerprint stability | Equivalent spec object-key orders and artifact-intent permutations produce the same sorted operations and fingerprint; applying an unchanged plan twice produces zero writes. | Duplicate paths, conflicting ownership/content, stale files after planning, and nondeterministic extension output fail closed. |

Property suites use the pinned seed `169279552` (`0x0a170040`) so a regression
cannot disappear on rerun. Set `AIYOKE_FAST_CHECK_SEED=<integer>` only for an
intentional exploratory or reproduction run, and record that override in the
failure report. A green line-coverage percentage is necessary but does not
replace these semantic properties; new generation or ownership behavior must
extend the corresponding property and adversarial case.

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
Expanded CI run `29532772411` passed every Linux, Windows, and macOS Node 22/24
test/build/isolation job, the exact npm tarball install/import/CLI smoke, coverage,
static architecture gates, production dependency audit, and both generated native
matrices.

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

Version 0.3 is approved and complete. Every 0.2 and 0.3 gate is Proven,
`pnpm check` and the protected release workflow passed from the tagged source,
the packed tarball was the artifact tested and published, and no unresolved
critical or high-severity security finding remained. The public
[v0.3.3 release](https://github.com/ryanpavlicek/aiyoke/releases/tag/v0.3.3)
and [release workflow](https://github.com/ryanpavlicek/aiyoke/actions/runs/29550589759)
are the canonical completion evidence. Future corrections follow the documented
patch-release and rollback process rather than reopening the 0.3 acceptance gate.
