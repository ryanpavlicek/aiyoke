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
node dist/cli.js plan
node dist/cli.js apply
node dist/cli.js check
```

`plan` is read-only. `apply` uses same-directory atomic replacement, rejects unsafe paths and
symlink traversal, and produces `.aiyoke/lock.json` for deterministic drift checks. Repeating
`apply` against an unchanged specification performs no writes.

## Development

Requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm dev --help
```

See `docs/architecture.md`, `docs/extensions.md`, and `docs/compatibility.md` for
design, extension contracts, and the tested support matrix.

## License

Apache-2.0.
