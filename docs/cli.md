# CLI reference

The installed `aiyoke` binary and `node dist/cli.js` expose the same interface.
Options may appear before or after the command. Unknown flags, missing values,
unsafe identifiers, invalid configuration, and I/O containment failures exit 1.
Configuration validation accumulates independent top-level, project, generation,
target-list, and pack-list defects in one pass. Human-readable errors print every
available dotted path with `line:column`; `--json` exposes the same ordered array
as `error.details.issues` for editor and CI integration.

## Global options

| Option | Meaning |
| --- | --- |
| `--root <path>` | Workspace root; defaults to the current directory. |
| `--json` | Emit structured results/errors for automation. |
| `--dry-run` | Preview `config`, `migrate`, or `rollback` without writing; invalid for other commands. |
| `--help`, `-h` | Print usage and exit 0. |

## `init`

```sh
aiyoke init [--preset <id>] [--languages <ids>] [--frameworks <ids>] [--targets <ids>] [--force]
```

Creates schema-v3 `aiyoke.yaml`. Comma-separated selections must be registered
IDs. `--preset simple` is the opinionated low-entry-cost path for a concise
Claude Code + OpenRouter setup; it fills ordinary selections and still emits
the same full schema-v3 document and validation evidence. Explicit selection
flags override the preset's corresponding lists. Presets are registered through
the application layer, so hosts can add one without modifying core logic.
If a configuration exists, the command makes no change unless `--force` is
present. `init` does not render target artifacts; follow with `plan` and `apply`.

## `config`

```sh
aiyoke config [--name <name>] [--architecture <kind>]
  [--languages <ids>] [--frameworks <ids>] [--targets <ids>] [--packs <ids>]
  [--dry-run]
aiyoke config --interactive [--dry-run]
```

Architecture is `layered`, `hexagonal`, `clean`, or `custom`. With no edit flags,
`config` prints canonical output without writing. Flags replace their selected
root lists while preserving settings for targets that remain selected.
Configuration is completely validated before a backup and write.

Interactive mode cannot be combined with edit flags and requires input/output
TTYs. It collects every answer, validates the complete result, and asks for
confirmation. Cancellation, EOF, and invalid answers do not modify the source.

## `detect` and `list`

`detect` reports registered language/framework evidence, confidence from 0 to 1,
and reasons. Detection observes the bounded workspace snapshot and does not edit
files. `list` reports every registered descriptor and is useful for discovering
valid IDs.

## `plan`

Computes deterministic `create`, `update`, `unchanged`, and `conflict` operations,
plus a content fingerprint. It never writes. Exit status is 1 when any operation
is a conflict; otherwise 0.

## `apply`

Loads the canonical source, creates a fresh plan, rejects conflicts/stale state,
and atomically applies changed owned artifacts. It reports changed paths or an
already-synchronized result. Repeating an unchanged apply performs no writes.

## `check` and `doctor`

`check` verifies generated lock/artifact digests and target-specific invariants.
`doctor` includes those findings plus readiness diagnostics for missing language
or target selections. Both exit 1 if any finding has severity `error`; warnings
alone exit 0. See the [error and finding catalog](errors-and-findings.md) for
stable codes, severity, and remediation. Extension-defined finding codes remain
valid strings and should be handled with an unknown-code fallback.

## `migrate`

```sh
aiyoke migrate [--to <positive-schema-version>] [--dry-run] [--allow-downgrade]
```

Runs registered adjacent migration steps. Normal project commands never migrate
silently. Downgrades require `--allow-downgrade` and still reject state the older
schema cannot represent. Successful writes report a content-addressed backup.

## `rollback`

```sh
aiyoke rollback --backup <path> [--dry-run]
```

Validates the selected Aiyoke backup, validates its complete migration path,
creates a safety backup of the current source, rechecks for concurrent changes,
and atomically restores it. Restoring an older schema may require a subsequent
`migrate` before normal generation.

## Exit and error contract

- `0`: successful command; warnings may still be present.
- `1`: invalid arguments/specification, conflict, error-severity finding,
  containment/I/O failure, or unexpected failure.

With `--json`, errors are written to stderr as:

```json
{
  "error": {
    "code": "INVALID_SPEC",
    "message": "...",
    "details": {}
  }
}
```

Human-readable errors contain the stable message but not stack traces, secret
values, or renderer-controlled exception text.

The installed help output and this command/flag inventory are compared by an
executable documentation test. A CLI change must update both in the same pull
request.
