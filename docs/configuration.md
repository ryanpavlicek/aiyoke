# Configuration, migration, and recovery

`aiyoke.yaml` is the canonical source for generated harness artifacts. Aiyoke
loads it strictly: unknown structural fields, duplicate keys, aliases, unsafe
paths, invalid variants, excessive input size, and excessive settings depth or
node count fail before extension resolution or filesystem writes.

## Schema version 3

Version 2 introduced explicit project composition. Version 3 adds a composed,
provider-neutral production runtime policy. A single project can use:

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
```

A monorepo has a root stack and one or more uniquely identified workspace roots:

```yaml
schemaVersion: 3
project:
  name: polyglot
  architecture: layered
composition:
  kind: monorepo
  root:
    languages:
      - typescript
    frameworks: []
  workspaces:
    - id: web
      path: apps/web
      stack:
        languages:
          - typescript
        frameworks:
          - nextjs
    - id: api
      path: services/api
      stack:
        languages:
          - python
        frameworks:
          - fastapi
runtime:
  kind: enabled
  outputDirectory: aiyoke-runtime
  profile:
    kind: production
```

Set `runtime.kind` to `disabled` to generate only developer-plane artifacts.
The production profile resolves to bounded retry, timeout, circuit-breaker,
structured-output repair, metadata-only events, offline evaluation, guarded
high-impact actions, token budgets, and concurrency/batch limits. A custom
profile must state every composed policy explicitly; unknown fields and unsafe
or out-of-range values fail closed.

When enabled, each selected language resolves exactly one registered runtime
template. The default output contains executable source, a resolved `policy.json`,
and integration guidance under `aiyoke-runtime/<language>`. Monorepo workspace
artifacts are rooted under that workspace's configured path.

The remainder of the document contains discriminated target configurations,
capability packs, and generation paths. Run `aiyoke init`, then inspect the
generated file for the complete canonical shape.

## Deterministic editing

Use flags in scripts and CI:

```sh
aiyoke config \
  --name example \
  --architecture clean \
  --languages typescript \
  --frameworks nextjs \
  --targets claude-code,codex,openrouter \
  --packs engineering \
  --dry-run
```

Remove `--dry-run` to write. For monorepos, language and framework flags update
the root stack; workspace stacks remain intact. Existing target-specific settings
are preserved when a selected target remains enabled. A successful write first
creates a recovery backup under `.aiyoke/backups`.

Run `aiyoke config` without editing flags to print the canonical configuration
without writing. Run `aiyoke config --interactive` only from a terminal. The
interactive flow gathers and validates every answer, then asks for confirmation;
cancellation, invalid input, EOF, and non-TTY execution do not modify the source.

## Migration

Normal commands never migrate silently. Preview and apply the complete adjacent
migration chain with:

```sh
aiyoke migrate --dry-run
aiyoke migrate
```

Use `--to <version>` to select a supported destination. Downgrades fail unless
`--allow-downgrade` is present, and a downgrade that cannot represent current
state—such as schema-v2 monorepo composition in schema v1 or customized runtime
policy in schema v2—fails even with consent.

Every applied migration prints a content-addressed backup path. Restore it with:

```sh
aiyoke rollback --backup .aiyoke/backups/aiyoke.v1-<digest>.yaml --dry-run
aiyoke rollback --backup .aiyoke/backups/aiyoke.v1-<digest>.yaml
```

Rollback validates the backup, creates a safety backup of the current file,
rechecks that the source did not change during preparation, and writes atomically.
Restoring an older schema intentionally requires running `aiyoke migrate` before
normal planning and generation resume.
