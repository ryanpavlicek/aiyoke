# aiyoke

`aiyoke` is a deterministic, extensible compiler for repository-local AI harnesses. It
translates one canonical specification into native artifacts for Claude Code,
ChatGPT/Codex, Grok/Grok Build, and OpenRouter, plus provider-neutral application
runtime templates for the selected languages.

## Status

The first release implements this contract:

1. `aiyoke init` creates a canonical project specification.
2. `aiyoke plan` reports changes without writing.
3. `aiyoke apply` writes atomically and is idempotent.
4. `aiyoke check` and `aiyoke doctor` detect drift and invalid target artifacts.
5. New targets, languages, frameworks, and capability packs are registered without
   changing the domain core.

First-party language support is limited to Python, TypeScript, JavaScript, Rust, and Go.
When schema-v3 runtime generation is enabled, each selected language receives
a provider-neutral, registry-driven execution facade and its native conformance
tests under `aiyoke-runtime/`. The generated runtime handles deadlines,
cancellation, retries, fallbacks, circuit breaking, output validation and repair,
redacted events, guards and approval, cache/evaluation ports, token and cost
budgets, and bounded batch concurrency without adding a provider SDK dependency.
Each runtime also includes registered `modules/tooling` and `modules/evaluation`
artifacts. They provide validated and approval-gated tool execution, redacted tool
events, bounded deadlines, versioned offline or sampled-online evaluation suites,
reproducibility metadata, baseline regression checks, report-sink delivery state,
and a human-feedback port. Capabilities that require an external service remain
explicit ports with runnable fake/reference tests rather than hidden hosted
dependencies.
Selected frameworks also receive registered thin request adapters that translate
framework request context, authorization inputs, cancellation where available,
and typed harness results without duplicating the runtime core.
Selecting OpenRouter or the xAI API also generates a registered Responses API
adapter and native contract tests. TypeScript, JavaScript, Python, and Go include
standard HTTP implementations; Rust exposes the same adapter over a typed
transport port so consumers can plug in their chosen TLS/HTTP crate. Secret
values enter only through an injected resolver and are redacted from failures.

First-party targets are Claude Code, Codex, ChatGPT plugins, Grok Build, the xAI/Grok API,
and OpenRouter. Provider credentials are referenced by environment-variable name and are never
written into generated files.

## Quick start

```sh
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js config --languages typescript --frameworks nextjs --targets claude-code,codex,openrouter --dry-run
node dist/cli.js plan
node dist/cli.js apply
node dist/cli.js check
```

Initialization enables all supported targets by default. Select a smaller native
surface when needed:

```sh
node dist/cli.js init --targets claude-code,codex,openrouter
```

Edit an existing specification deterministically with `aiyoke config` flags, or
use `aiyoke config --interactive` from a TTY. Preview either mode with
`--dry-run`. Older specifications are upgraded one version at a time with
`aiyoke migrate --dry-run` and `aiyoke migrate`; every write reports a
content-addressed recovery backup accepted by `aiyoke rollback --backup <path>`.

`plan` is read-only. `apply` uses same-directory atomic replacement, rejects unsafe paths and
symlink traversal, and produces `.aiyoke/lock.json` for deterministic drift checks. Repeating
`apply` against an unchanged specification performs no writes. Root instruction files use
explicit managed-section boundaries, so existing user-authored content remains outside aiyoke's
write scope.

## Development

Requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm dev --help
```

See `docs/architecture.md`, `docs/extensions.md`, and `docs/compatibility.md` for
design, extension contracts, and the tested support matrix. Public-release work
is tracked through evidence-based gates in `docs/release-readiness.md`. The
generated production capabilities and their product boundary are specified in
`docs/runtime-harness-contract.md`. Configuration schema, editing, migration,
and recovery are documented in `docs/configuration.md`.

## License

Apache-2.0.
