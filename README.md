# Aiyoke

[![CI](https://github.com/ryanpavlicek/aiyoke/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanpavlicek/aiyoke/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Aiyoke is a deterministic, extensible templating kit for repository-local AI
harnesses. One canonical `aiyoke.yaml` compiles into native configuration for
Claude Code, ChatGPT/Codex, Grok/Grok Build, and OpenRouter, plus optional
provider-neutral application-runtime harness templates for Python, TypeScript,
JavaScript, Rust, and Go.

It gives teams one reviewed source for AI tooling instead of a collection of
hand-maintained agent files. Planning is read-only, generation is atomic and
idempotent, drift is detectable, secrets remain environment-only, and new
capabilities enter through versioned registries rather than provider branches in
the core.

> Aiyoke generates harness configuration and runtime source templates. It is not
> a hosted model gateway, telemetry backend, approval service, or secret store.
> Where a first-party service is outside the project boundary, generated ports,
> adapters, runnable fakes, and integration templates make that boundary explicit.

## Status

Version 0.3.3 is the current public hardening release. Its code, target,
language, framework, runtime, package, and clean-clone gates have reproducible evidence in
[Public release readiness](docs/release-readiness.md). Publication remains a
deliberate maintainer action behind the protected npm environment; unproven
behavior is not silently presented as complete.

## What Aiyoke generates

Aiyoke has two related output planes:

1. The developer plane renders each AI tool's native repository files—agent
   instructions, skills, hooks, subagents, plugin metadata, MCP configuration,
   provider references, and routing configuration.
2. The application plane renders a provider-neutral runtime facade for each
   selected language, with registered provider/tool/evaluation adapters and thin
   framework request integrations.

Generated runtime templates include bounded retries, deadlines and cancellation,
fallback and circuit-breaker policies, structured-output validation/repair,
redacted events, approval and guard ports, caching and evaluation ports, token
and cost budgets, and bounded batch concurrency. External implementations remain
replaceable through registration contracts.

## Supported surface

| AI surface | Native target |
| --- | --- |
| Claude Code | `claude-code` |
| Codex | `codex` |
| ChatGPT plugin package | `chatgpt` |
| Grok Build | `grok-build` |
| Grok/xAI Responses API | `xai-api` |
| OpenRouter inference gateway | `openrouter` |

| Language | Framework integrations |
| --- | --- |
| Python | FastAPI, Django, Flask |
| TypeScript | Next.js, NestJS, Fastify, Express |
| JavaScript | Next.js, Fastify, Express |
| Rust | Axum, Actix Web |
| Go | Chi, Gin, Fiber |

See the [compatibility matrix](docs/compatibility.md) for the exact generated
artifacts, runtime/provider contract, test depth, and scope boundaries.

## Install

Aiyoke requires Node.js 22 or newer. Install it in the repository whose harness
you want to manage:

```sh
npm install --save-dev aiyoke
```

The repository itself uses pnpm 11.7.0 for locked development and release gates.

## Five-minute setup

From an existing TypeScript/Next.js repository:

```sh
npx aiyoke init \
  --languages typescript \
  --frameworks nextjs \
  --targets claude-code,codex,openrouter

npx aiyoke plan
npx aiyoke apply
npx aiyoke check
```

`init` creates `aiyoke.yaml`; it does not generate target files. `plan` shows the
complete deterministic operation set and fingerprint without writing. `apply`
writes owned artifacts and `.aiyoke/lock.json`. A second unchanged apply reports
zero writes. Commit the canonical configuration, generated artifacts appropriate
for your team, and the lock file according to your repository policy.

The executable [Next.js quickstart](examples/quickstart-nextjs/README.md) walks
through initialization, plan review, the generated tree, idempotent application,
intentional drift, and recovery from a checked-in starter project.

Use `--root <path>` from a parent directory and `--json` in automation:

```sh
npx aiyoke plan --root ./services/api --json
```

## Documentation map

Start with the [documentation map](docs/README.md) for audience-specific paths:
first use, configuration and operations, extension authoring, public API
integration, architecture, contribution, security, or release maintenance. Every
document ships in the npm package, and local links and anchors are validated in
the default quality gate.

## Canonical configuration

Schema version 3 distinguishes project composition and runtime state instead of
placing unrelated optional fields in one object:

```yaml
schemaVersion: 3
project:
  name: example
  architecture: layered
composition:
  kind: single
  stack:
    languages:
      - typescript
    frameworks:
      - nextjs
runtime:
  kind: enabled
  outputDirectory: aiyoke-runtime
  profile:
    kind: production
targets:
  - kind: coding-agent
    adapter: claude-code
    features:
      - instructions
      - skills
    settings: {}
  - kind: inference-gateway
    adapter: openrouter
    routing:
      kind: fixed
      model: openrouter/free
    settings: {}
packs:
  - engineering
generation:
  sourceDirectory: .aiyoke
  lockFile: .aiyoke/lock.json
  lineEndings: lf
```

Configuration parsing is strict and bounded. Unknown fields, duplicate YAML
keys, aliases, unsafe paths, invalid unions, excessive nesting, and unsupported
extension references fail before generation. Monorepos use a discriminated
`composition.kind: monorepo` variant with explicit root and workspace stacks;
see [Configuration, migration, and recovery](docs/configuration.md).

## Daily workflow

```sh
# Inspect evidence-based language/framework detection.
npx aiyoke detect

# List every registered target, language, framework, pack, and runtime.
npx aiyoke list

# Preview and apply deterministic configuration changes.
npx aiyoke config --languages typescript --frameworks nextjs --dry-run
npx aiyoke config --languages typescript --frameworks nextjs

# Inspect, generate, and verify.
npx aiyoke plan
npx aiyoke apply
npx aiyoke check
npx aiyoke doctor
```

`config --interactive` is available only when both input and output are TTYs;
automation must use deterministic flags. `doctor` adds readiness findings such
as missing languages or targets to ordinary drift verification.

### Command summary

| Command | Purpose | Writes? |
| --- | --- | --- |
| `init` | Create the canonical schema-v3 configuration | Only when absent or `--force` |
| `config` | Print, preview, or edit deterministic selections | With edit flags and no `--dry-run` |
| `detect` | Report language/framework evidence and confidence | No |
| `list` | List registered extension descriptors | No |
| `plan` | Compute ordered operations and a fingerprint | No |
| `apply` | Apply a fresh plan atomically | Yes |
| `check` | Verify lock/artifact drift and target invariants | No |
| `doctor` | Run `check` plus configuration-readiness diagnostics | No |
| `migrate` | Preview/apply adjacent schema migrations | Unless `--dry-run` |
| `rollback` | Restore a validated content-addressed backup | Unless `--dry-run` |

The complete option and exit-code contract is in the [CLI reference](docs/cli.md).

## Safe generation and recovery

Aiyoke normalizes paths, rejects traversal and symbolic-link ancestors, binds an
atomic write's staged file to the verified real parent, and rechecks that parent
before rename. Generated files have explicit ownership:

- `generated` owns the complete file;
- `managed-section` owns only a uniquely marked bounded region; and
- `user-owned` refuses replacement.

Plans fail before writes on duplicate paths, conflicting owners, missing
extensions, dependency cycles, stale source, or malformed managed markers.
Migration/configuration writes create content-addressed backups under
`.aiyoke/backups`; preview recovery before applying it:

```sh
npx aiyoke rollback --backup .aiyoke/backups/aiyoke.v2-<digest>.yaml --dry-run
npx aiyoke rollback --backup .aiyoke/backups/aiyoke.v2-<digest>.yaml
```

## Provider credentials and live checks

Generated target/runtime configuration stores environment-variable names such as
`OPENROUTER_API_KEY` and `XAI_API_KEY`, never values. Aiyoke does not load `.env`
during normal planning, generation, or tests. Applications inject secrets through
the generated resolver port.

Repository maintainers may explicitly exercise a generated OpenRouter adapter:

```powershell
Copy-Item .env.example .env
# Add OPENROUTER_API_KEY to the ignored local .env file.
$env:AIYOKE_LIVE_PROVIDER_TESTS = "1"
pnpm test:live
```

The live smoke is opt-in, bounded, non-streaming, and prints token counts only.
It defaults to `openrouter/free`; set `AIYOKE_LIVE_OPENROUTER_MODEL` to override
the route. Default CI uses local transports and never needs provider credentials.

## Extensions

Targets, languages, frameworks, capability packs, and runtime templates implement
the public contracts from `aiyoke/extension-sdk` and register an
`ExtensionLoader`. The registry validates `(kind, id)`, API version, requirements,
conflicts, cycles, and loader identity before resolution. The core never imports a
provider or extension implementation.

External authors can run the public compatibility kit:

```ts
import { runExtensionCompatibility } from "aiyoke/extension-sdk";

const report = await runExtensionCompatibility({ loader, fixture });
if (report.kind === "failed") throw new Error(JSON.stringify(report.findings));
```

Installable packages can use strict Ed25519-signed manifests, offline trust roots,
key/content/manifest revocation, and exact-digest user consent. Target/runtime
renderers can run through the optional bounded child-process adapter. The complete
external `hello-target` template is under
[`examples/extensions/hello-target`](examples/extensions/hello-target).

See [Extension authoring](docs/extensions.md) and the [public API
reference](docs/api.md). Process isolation is defense in depth, not an OS sandbox.

## Architecture

Dependencies flow inward/downward:

```text
Interfaces (CLI)
        ↓
Engine / composition → first-party extension loaders
        ↓                         ↓
Infrastructure → Application → Extension SDK
                                  ↓
                                 Core
```

Core contains dependency-free domain types and invariants. The SDK depends only
on core. Application use cases depend on core/SDK. Infrastructure implements
downward-facing ports. The engine composes those layers and lazy extension
loaders; the public facade dynamically imports heavy modules. A TypeScript-AST
architecture gate rejects forbidden static edges and heavy public-entry imports.

Read [Architecture](docs/architecture.md) and the ADRs before changing a layer.

## Troubleshooting

- `aiyoke.yaml was not found`: run `aiyoke init` in the intended `--root`.
- Configuration already exists: omit `init`, use `config`, or use `init --force`
  only when replacement is intentional.
- A plan reports conflicts: inspect duplicate ownership, managed markers, or
  extension conflicts; `apply` will not bypass them.
- `check` reports drift: review `plan`, then apply only after the changed canonical
  source and generated diff are understood.
- An old schema fails normal commands: run `migrate --dry-run`, then `migrate`.
- Interactive configuration fails in CI: use flags; interactivity deliberately
  requires a TTY.
- A path traverses a symlink/non-directory: move the output under a real workspace
  directory. Aiyoke will not weaken containment.
- A provider call lacks a key: inject it into the consuming runtime's secret
  resolver. Generation itself should not need the value.

More diagnoses and recovery steps are in [Troubleshooting](docs/troubleshooting.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:targets
pnpm test:target-clients
pnpm test:runtimes
pnpm test:frameworks
pnpm test:package
pnpm test:docs:external
```

CI separately enforces formatting/types/architecture, Node 22 and 24 on Linux,
Windows, and macOS, coverage of the complete source tree, package contents/npm
install/CLI smoke, strict publint and ESM type-resolution checks, production
dependency audit, dependency review, generated native runtimes, framework
adapters, strict target contracts, and pinned Claude/Codex/Grok client probes.
Direct tool versions and third-party workflow actions are immutable pins; automated
tests reject floating replacements.
Local documentation links, anchors, and code fences run in every static gate;
external URL availability runs through the bounded weekly documentation workflow
and can be checked locally with `pnpm test:docs:external`.
Tagged releases build and attest one exact tarball; see [Release
operations](docs/releasing.md).

Contributions must preserve deterministic output and downward dependencies, add
capabilities through registration, and include focused/adversarial evidence. See
[Contributing](CONTRIBUTING.md) and [Security policy](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
