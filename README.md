# aiyoke

`aiyoke` is a deterministic, extensible compiler for repository-local AI harnesses. It
translates one canonical specification into native artifacts for Claude Code,
ChatGPT/Codex, Grok/Grok Build, and OpenRouter.

## Status

The first release implements this contract:

1. `aiyoke init` creates a canonical project specification.
2. `aiyoke plan` reports changes without writing.
3. `aiyoke apply` writes atomically and is idempotent.
4. `aiyoke check` and `aiyoke doctor` detect drift and invalid target artifacts.
5. New targets, languages, frameworks, and capability packs are registered without
   changing the domain core.

First-party language support is limited to Python, TypeScript, JavaScript, Rust, and Go.

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
