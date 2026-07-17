# Contributing

Thank you for improving Aiyoke. Contributions are welcome across code,
extensions, examples, documentation, tests, and design proposals. This guide is
the maintainer contract for getting a change from an idea to a reviewable pull
request.

## Start here

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), not a public issue.
- Read [Architecture](docs/architecture.md) before changing a dependency edge.
- Read [Extension authoring](docs/extensions.md) before adding a target,
  language, framework, pack, or runtime.
- Use the [documentation map](docs/README.md) to find the contract relevant to
  your change.

If the intended behavior is unclear, open a focused issue before writing a large
patch. Describe the user problem, the proposed registration point or downward
layer change, compatibility impact, and how the result can be verified.

## Prerequisites

- Git
- Node.js 22 or 24
- pnpm 11.7.0, as pinned by `packageManager` in `package.json`

The ordinary TypeScript gate needs only Node and pnpm. Native runtime and
framework validation additionally needs the Python, Go, and Rust versions pinned
in `.github/workflows/ci.yml`. Target-client validation downloads or installs the
exact reviewed Claude Code, Codex, and Grok Build clients declared under
`scripts/`.

Install from a clean clone:

```sh
git clone https://github.com/ryanpavlicek/aiyoke.git
cd aiyoke
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Do not commit `.env`, credentials, downloaded clients, coverage, build output,
or generated dependency directories. Use fake transports for default tests; the
live provider smoke is opt-in and never a prerequisite for a pull request.

## Repository map and dependency direction

| Area | Responsibility | May depend on |
| --- | --- | --- |
| `src/core` | Stable domain types, invariants, identities, errors | Nothing higher |
| `src/extension-sdk` | Versioned extension and compatibility contracts | Core |
| `src/application` | Use cases and downward-facing ports | Core and SDK |
| `src/infrastructure` | Filesystem, configuration, discovery, hashing, isolation | Application ports, SDK, core |
| `src/extensions` | Registered first-party targets, stacks, packs, runtimes | SDK and core |
| `src/engine` | Composition and lazy loader registration | Lower layers and extensions |
| `src/interfaces` | CLI and interactive adapters | Engine and lower public contracts |
| `src/index.ts` | Small lazy public facade | Types and intentionally lazy imports |

Dependencies point downward. Core must never import application, infrastructure,
engine, interfaces, or first-party extensions. New capabilities enter through
`ExtensionLoader` registration rather than provider, language, or framework
branches in core. `pnpm architecture` enforces these rules with the TypeScript
AST rather than filename conventions alone.

## Development workflow

1. Start from an up-to-date `main` and create a focused branch.
2. Add or update the smallest test that demonstrates the intended contract.
3. Implement through the correct layer or registration point.
4. Run focused checks while iterating.
5. Run `pnpm check` before opening the pull request.
6. Run specialized gates when the changed surface requires them.
7. Update user documentation and `CHANGELOG.md` under `Unreleased` for a
   user-visible change.

Useful commands:

| Command | Use it for |
| --- | --- |
| `pnpm lint` | Formatting and static lint rules |
| `pnpm typecheck` | Strict source and test type checking |
| `pnpm architecture` | Downward-dependency and lazy-facade rules |
| `pnpm test` | Unit and integration tests |
| `pnpm test:coverage` | Full tests with enforced source-wide thresholds |
| `pnpm test:docs` | Markdown files, links, anchors, fences, and required navigation |
| `pnpm test:docs:external` | Bounded live availability check for external documentation links |
| `pnpm test:targets` | Deterministic target artifact contracts |
| `pnpm test:target-clients` | Exact native Claude, Codex, and Grok client probes |
| `pnpm test:runtimes` | Generated Python, TypeScript, JavaScript, Rust, and Go runtimes |
| `pnpm test:frameworks` | Generated integrations against pinned real frameworks |
| `pnpm test:package` | Exact npm tarball, types, contents, install, import, and CLI smoke |
| `pnpm check` | Required local static, coverage, build, and isolation gate |

Tests must be deterministic, offline by default, bounded in time and output, and
safe to run concurrently. Property tests use committed seeds or print enough
information to reproduce a failure. Adversarial tests should assert both the
rejection and the absence of a partial write, secret leak, or outside-workspace
effect.

## Change recipes

### Add or change an extension

1. Implement the appropriate SDK contract under `src/extensions` or an external
   package.
2. Export an `ExtensionLoader` whose descriptor exactly matches the loaded
   extension.
3. Register the loader in the engine composition root; do not add core dispatch
   branches.
4. Declare requirements and conflicts explicitly.
5. Add focused behavior tests, deterministic artifact assertions, and hostile
   settings/path/secret cases.
6. Update the compatibility matrix and authoring documentation.
7. Run the public compatibility kit when the extension can live outside the
   built-in tree.

### Change configuration or domain state

Use composition and discriminated unions instead of optional-field growth. A
schema change requires strict parser/stringifier coverage, round trips, malformed
input cases, an adjacent reversible migration where representation permits it,
backup/rollback coverage, examples, and migration documentation. Normal commands
must never migrate silently.

### Change generated artifacts

Preserve canonical ordering, LF output, safe relative paths, explicit ownership,
and idempotence. Add or update exact artifact fixtures, drift checks, second-apply
zero-write coverage, package contents where applicable, and native client/runtime
evidence for every affected supported surface.

### Change the CLI or public API

Keep the root facade intentional and lazy. Document every new flag, result
variant, error, write effect, and migration implication. Update the CLI help and
the executable documentation parity tests together. A breaking extension SDK
contract requires an API-version decision and migration notes.

### Change documentation

Prefer runnable commands and complete examples over claims. Keep internal links
relative so they work in GitHub and the npm tarball. Run `pnpm test:docs`; run
`pnpm test:docs:external` when adding or changing external links. User-facing
command examples should be exercised by a test or an existing package/CLI gate.

## Pull requests

Keep a pull request scoped to one coherent change. Complete the repository pull
request template and include:

- the user problem and outcome;
- the affected layer or registration point;
- compatibility, security, and migration impact;
- exact commands run and any platform-specific limitations; and
- before/after examples for user-visible output.

Required checks must pass from an up-to-date branch. Reviews may request smaller
commits, additional hostile cases, or a clearer extension boundary even when the
happy path is green. Do not weaken tests, coverage, containment, pinning, or
security rules merely to make a check pass.

Use conventional, focused commit subjects such as `feat:`, `fix:`, `docs:`,
`test:`, `refactor:`, or `chore:`. Squash merge is the repository policy, so the
pull request title should also be a useful changelog-quality commit subject.

## Release responsibility

Maintainers own versioning, tags, npm environment approval, provenance, release
assets, deprecation, and rollback. Contributors should not change package
versions or create release tags unless a maintainer explicitly coordinates that
release. See [Release operations](docs/releasing.md) for the protected process.
