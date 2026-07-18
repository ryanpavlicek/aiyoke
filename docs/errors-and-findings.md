# Errors and findings

This is the public catalog for machine-readable diagnostics. Aiyoke exposes
two related contracts:

- `AiyokeError.code` is thrown when a command or API call cannot complete.
- `VerificationFinding.code` is returned by `check()`/`doctor()` when a
  configuration or generated artifact needs attention.

The extension compatibility kit also returns a small, stable finding catalog.
The `code` field on extension-provided verification findings remains an open
string so an extension can report a domain-specific condition without a core
release. Callers should branch on `code` and `severity`, not on message text;
messages are for people and may gain context over time.

## Error codes

These values are exported as `AiyokeErrorCode` from `aiyoke/core`; the lightweight
root facade exposes `AiyokeError` whose `code` property uses this same contract.
They are stable identifiers within the public major line: a code is not
repurposed for a different condition. New codes may be added in a minor release;
consumers should keep an unknown-code fallback.

The CLI also has one transport-only fallback code, `UNEXPECTED`, for an
exception that is outside the structured `AiyokeError` contract. It is included
in the built-in diagnostic catalog but is intentionally not an
`AiyokeErrorCode`, because library callers receive the original thrown value.

| Code | Meaning | Usual remediation |
| --- | --- | --- |
| `INVALID_SPEC` | The CLI arguments, `aiyoke.yaml`, migration input, or selected extension kind is malformed or inconsistent. | Read the bounded message/details, correct the canonical configuration or flags, then rerun `plan` or the command. Run `migrate --dry-run` for an older schema. |
| `INVALID_PATH` | A path is absolute, traverses outside the workspace, crosses a symlink/non-directory, or is otherwise unsafe for a generated artifact. | Use a normalized relative path under the selected workspace and remove the symlink/traversal. Aiyoke intentionally fails closed. |
| `EXTENSION_DUPLICATE` | The registry already contains the `(kind, id)` loader, or a second runtime claims the same language. | Keep one registered owner and give a replacement a new stable ID or remove the duplicate. |
| `EXTENSION_MISSING` | A selected or required extension is not registered. | Install/register the extension before composition, or remove the stale reference from the spec. |
| `EXTENSION_CONFLICT` | Two selected extensions declare incompatible requirements. | Select one side of the conflict or change the extension descriptors; do not bypass registry resolution. |
| `EXTENSION_CYCLE` | Extension requirements contain a dependency cycle. | Break the cycle so dependencies form a directed acyclic graph. |
| `EXTENSION_API_MISMATCH` | A loader advertises an extension SDK API version other than `EXTENSION_API_VERSION`. | Pin a compatible extension release or deliberately migrate the SDK contract. |
| `REGISTRY_FROZEN` | Registration was attempted after the registry was frozen for resolution. | Register all loaders during composition, then freeze once; create a new registry for a different composition. |
| `ARTIFACT_CONFLICT` | The domain cannot safely combine artifact intents (for example, incompatible ownership/content for one path). | Inspect the `plan` conflict sources and choose one owner, compatible managed markers, or distinct paths. |
| `PLAN_CONFLICT` | A plan contains conflicts, or a workspace file changed after the plan was created. | Review the conflict, regenerate a fresh plan, and apply only after the source and workspace are stable. |
| `WORKSPACE_IO` | A bounded workspace read, write, backup, or rollback operation failed. | Check the path, permissions, disk state, and backup location; retry after resolving the underlying I/O condition. |
| `VALIDATION_FAILED` | A boundary validator rejected a value that otherwise reached a generic validation port. | Treat details as untrusted input, correct the value or extension output, and rerun validation. |

### CLI-only error envelope

| Code | Meaning | Usual remediation |
| --- | --- | --- |
| `UNEXPECTED` | The command caught an exception outside the structured Aiyoke error contract. | Capture the command and sanitized output for a reproducible defect report; do not retry indefinitely or parse its message. |

The `details` object is bounded JSON intended for automation (for example,
`path`, `extension`, `fingerprint`, or `conflicts`). It must not be assumed to
have the same keys for every occurrence, and it never contains credentials.
Configuration failures may include `details.issues`, an ordered array of
`{ path, message, line?, column? }` entries. Positions are one-based and are
best-effort for semantic errors; YAML syntax errors use the parser's position.

## Built-in verification findings

`VerificationFinding` values are returned in deterministic order. `check()`
returns artifact/target verification; `doctor()` adds readiness findings. A
finding with severity `error` makes the CLI exit 1. Warnings and informational
findings do not, by themselves, make a command fail.

| Code | Severity | Meaning | Remediation |
| --- | --- | --- | --- |
| `GENERATED_DRIFT` | error | A generated artifact would be created or updated relative to the current workspace. | Review `plan`, commit or correct the canonical source, then run `apply` intentionally. |
| `ARTIFACT_CONFLICT` | error | Artifact intents disagree, an existing user-owned file would be replaced, or managed markers are ambiguous. | Resolve ownership/content/marker conflicts; Aiyoke will not overwrite user-owned content. |
| `ARTIFACT_MISSING` | warning | A target's expected generated file is absent. | Run `plan`/`apply`, or confirm that the target's artifact is intentionally excluded. |
| `TARGET_ADAPTER_MISMATCH` | error | A target extension was asked to verify a different adapter ID than the one it implements. | Correct the target registration/spec or update the extension descriptor. |
| `TARGET_KIND_MISMATCH` | error | A target adapter was selected for a surface it does not implement. | Use the adapter's declared target kind or select a matching adapter. |
| `INVALID_OPENROUTER_PROTOCOL` | error | OpenRouter settings request neither `chat-completions` nor the explicit `responses` protocol. | Set `targets[].settings.protocol` to a supported value or omit it for the default. |
| `EMPTY_FALLBACK_ROUTE` | error | OpenRouter fallback routing has no models. | Add at least one model to `routing.models`. |
| `EMPTY_FALLBACK_MODEL` | error | An OpenRouter fallback route contains a blank model ID. | Remove blank entries and use non-empty model identifiers. |
| `EMPTY_FIXED_ROUTE` | error | OpenRouter fixed routing has an empty model ID. | Set `routing.model` to a non-empty model identifier. |
| `EMPTY_PROVIDER_ORDER` | error | OpenRouter capability routing has no provider order. | Add at least one provider to `routing.providerOrder`. |
| `MODULE_DEFINITION_CONFLICT` | error | Two selected extensions define the same skill, subagent, hook, or MCP namespace. | Rename or remove one definition so generated module identities are unambiguous. |
| `NO_LANGUAGES` | warning | `doctor` found no language extension in the selected project or monorepo stack. | Select a supported language, or intentionally keep a target-only project and acknowledge the warning. |
| `NO_TARGETS` | error | `doctor` found no AI target adapter. | Select at least one target such as `claude-code`, `codex`, `grok-build`, or `openrouter`. |
| `READY` | info | `doctor` found no error-severity findings. | No action is required; continue with the normal plan/apply/check workflow. |

Extensions may return additional verification findings. Their codes are not
restricted by the core so that new adapters do not require a core switch or
release. Prefix extension-owned codes with a stable publisher/extension
namespace (for example, `acme.example_target.AUTH_EXPIRED`), document their
severity and remediation, and preserve their meaning across releases.

## Compatibility-kit findings

`runExtensionCompatibility()` returns these findings when an extension package
does not satisfy the public kit. The `check` field identifies the failed kit
phase.

| Code | Check | Meaning / remediation |
| --- | --- | --- |
| `INVALID_DESCRIPTOR` | `descriptor` | Loader descriptor shape or identity is invalid; correct required fields, IDs, versions, or capabilities. |
| `DEPENDENCY_GRAPH_INVALID` | `dependencies` | Dependencies are missing, conflicting, duplicated, or cyclic; fix the extension registry declarations. |
| `LOADER_IDENTITY_INVALID` | `loader-identity` | Lazy `load()` returned a descriptor different from the advertised one; return the exact descriptor. |
| `EXTENSION_EXECUTION_FAILED` | `execution` | Detection/contribution/render/verification threw or returned an invalid shape; reproduce with the fixture and contain errors. |
| `UNSAFE_EXTENSION_OUTPUT` | `artifact-safety` | Output has unsafe paths, duplicate ownership, invalid markers, excess size, unsupported line endings, or another artifact contract violation. |
| `NONDETERMINISTIC_OUTPUT` | `determinism` | Two executions against the same fixture produced different bytes; sort output and remove timestamps/randomness. |
| `SECRET_CANARY_LEAKED` | `secret-safety` | A configured secret canary appeared in an artifact, finding, or serialized output; remove the secret-bearing path and add redaction. |
| `DETERMINISM_NOT_TESTED` | `determinism` | Execution did not reach the repeatability assertion; fix the earlier execution failure first. |
| `SECRET_SAFETY_NOT_TESTED` | `secret-safety` | Execution did not reach the canary assertion; fix the earlier execution failure first. |

## Automation guidance

For CLI automation, use `--json` and read `error.code` or finding `code` plus
`severity`. Treat unknown codes as actionable diagnostics rather than assuming
they are harmless. Never parse human-readable messages, stack traces, or
renderer-controlled exception text. See the [CLI reference](cli.md),
[public API reference](api.md#errors-and-findings), and
[extension authoring](extensions.md#verification-and-finding-codes) for the
corresponding type contracts.

Library tooling that needs the complete built-in catalog can call the lazy root
facade:

```ts
import { getBuiltinDiagnosticCatalog } from "aiyoke";

const catalog = await getBuiltinDiagnosticCatalog();
const errors = catalog.filter((entry) => entry.channel === "error");
```

The returned array is deterministically ordered and frozen, and its entries are
readonly by the TypeScript contract. They are useful for CI display/policy
checks, while `AIYOKE_ERROR_CODES` from `aiyoke/core` is the smaller
synchronous tuple for code-only error validation. Neither catalog authorizes an
extension or replaces the extension-defined finding namespace.
