# Configuration, migration, and recovery

`aiyoke.yaml` is the canonical source for generated harness artifacts. This is
the complete schema-v3 reference: fields are required unless a table explicitly
marks them optional or gives a parser default. Aiyoke rejects unknown structural
fields rather than silently ignoring misspellings.

## Document limits and normalization

- Maximum UTF-8 source size: 1 MiB.
- YAML 1.2 core schema, with duplicate keys, aliases, merge keys, parser
  warnings, and invalid syntax rejected.
- Maximum JSON-compatible depth: 64; maximum node count: 10,000.
- Settings values must be finite JSON values. `undefined`, functions, non-finite
  numbers, cyclic values, and prototype-related object keys are rejected.
- Extension IDs use lower-case kebab-case: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
- Generated paths are relative, forward-slash normalized, and may not contain
  absolute roots, `.` or `..` components, blank components, Windows device
  names, trailing dots/spaces, control bytes, or Windows-invalid characters.
- Lists documented as sets reject duplicates. Serialization is canonical and
  uses LF line endings.

## Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | literal `3` | Current canonical schema; older documents require `migrate`. |
| `project` | object | Project identity and architecture vocabulary. |
| `composition` | discriminated union | Single-project or explicit monorepo stacks. |
| `runtime` | discriminated union | Disabled, production profile, or a fully stated custom policy. |
| `targets` | array | Native AI target/provider variants; duplicate `(kind, adapter)` pairs are rejected. |
| `packs` | extension-ID array | Registered capability packs; defaults to an empty array only when parsing hand-written YAML. |
| `generation` | object | Source, lock, and line-ending policy. |

The default created by `aiyoke init` is intentionally richer than parser
fallbacks: TypeScript, all six built-in targets, the production runtime, and the
`engineering` pack are selected unless flags or evidence-based detection replace
the stack/target selections.

## Project

```yaml
project:
  name: example
  architecture: layered
```

| Field | Accepted values |
| --- | --- |
| `name` | Any non-empty string. It becomes display metadata, not a filesystem path. |
| `architecture` | `layered`, `hexagonal`, `clean`, or `custom`. |

Architecture is instructional project metadata. It does not change Aiyoke's own
enforced internal layering.

## Composition

### Single project

```yaml
composition:
  kind: single
  stack:
    languages:
      - typescript
    frameworks:
      - nextjs
```

`stack.languages` and `stack.frameworks` are unique registered extension-ID
arrays. Empty arrays are valid, although `doctor` warns when no language is
selected. A framework normally declares its required language through the
extension registry; unresolved requirements fail before rendering.

### Monorepo

```yaml
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
```

`root` uses the same stack shape as a single project. `workspaces` must be a
non-empty array. Each workspace has a unique extension-format `id`, a unique safe
relative `path`, and an explicit stack. Runtime artifacts for a workspace are
rooted below that workspace path; root selections remain project-scoped.

The deterministic `config --languages/--frameworks` flags update a single
project's stack or a monorepo's root stack. They never rewrite workspace stacks.

## Runtime

Disable application-plane generation while retaining developer-plane targets:

```yaml
runtime:
  kind: disabled
```

Enable the reviewed production defaults:

```yaml
runtime:
  kind: enabled
  outputDirectory: aiyoke-runtime
  profile:
    kind: production
```

`outputDirectory` is a safe relative path. When enabled, every selected language
must resolve exactly one registered runtime template.

### Production defaults

| Policy | Production value |
| --- | --- |
| Timeout | 30,000 ms |
| Retry | 3 attempts; 250 ms base; 4,000 ms maximum; 0.2 jitter ratio |
| Circuit breaker | 5 failures; 30,000 ms reset; 1 half-open attempt |
| Fallback | Disabled |
| Structured-output repair | 1 attempt |
| Observability | Metadata-only events with token and estimated-cost fields |
| Evaluation | Offline |
| Safety | Guarded; approval for high-impact actions; redacted audit |
| Cache | Disabled |
| Token budget | 32,000 input; 4,096 output |
| Cost budget | Disabled |
| Concurrency and batch | 8 concurrent; 16 per batch |

### Custom runtime profile

A custom profile must state every policy family—there is no partial merge with
production defaults:

```yaml
runtime:
  kind: enabled
  outputDirectory: aiyoke-runtime
  profile:
    kind: custom
    reliability:
      timeoutMs: 20000
      retry:
        kind: bounded
        maxAttempts: 2
        baseDelayMs: 200
        maxDelayMs: 2000
        jitterRatio: 0.1
      circuitBreaker:
        kind: failure-threshold
        failureThreshold: 5
        resetAfterMs: 30000
        halfOpenMaxAttempts: 1
      fallback:
        kind: ordered
        routes:
          - primary
          - backup
      maxRepairAttempts: 1
    observability:
      kind: events
      contentCapture: metadata-only
      emitTokenUsage: true
      emitEstimatedCost: true
    evaluation:
      kind: sampled-online
      sampleRate: 0.05
    safety:
      kind: guarded
      humanApproval: high-impact
      audit: redacted
    performance:
      cache:
        kind: registered
        namespace: example
      tokenBudget:
        kind: limited
        maxInputTokens: 32000
        maxOutputTokens: 4096
      costBudget:
        kind: limited
        maxEstimatedCostUsd: 1.5
      maxConcurrency: 8
      maxBatchSize: 16
```

### Custom policy constraints

| Field or variant | Constraint |
| --- | --- |
| `reliability.timeoutMs` | Integer 1–600,000 |
| `retry.kind` | `disabled` or `bounded` |
| `retry.maxAttempts` | Integer 1–10 |
| `retry.baseDelayMs` | Integer 0–60,000 |
| `retry.maxDelayMs` | Integer 0–300,000 and not less than `baseDelayMs` |
| `retry.jitterRatio` | Number 0–1 |
| `circuitBreaker.kind` | `disabled` or `failure-threshold` |
| `failureThreshold` | Integer 1–100 |
| `resetAfterMs` | Integer 1–3,600,000 |
| `halfOpenMaxAttempts` | Integer 1–10 |
| `fallback.kind` | `disabled` or `ordered` |
| `fallback.routes` | Non-empty, unique, non-blank string array for `ordered` |
| `maxRepairAttempts` | Integer 0–5 |
| `observability.kind` | Literal `events` |
| `contentCapture` | `metadata-only` or `redacted` |
| `emitTokenUsage`, `emitEstimatedCost` | Boolean |
| `evaluation.kind` | `offline` or `sampled-online` |
| `evaluation.sampleRate` | Number 0.000001–1 for `sampled-online` |
| `safety.kind` | Literal `guarded` |
| `humanApproval` | `disabled` or `high-impact` |
| `audit` | Literal `redacted` |
| `cache.kind` | `disabled` or `registered` |
| `cache.namespace` | Non-empty string for `registered` |
| `tokenBudget.kind` | `disabled` or `limited` |
| Token maxima | Integers 1–10,000,000 for `limited` |
| `costBudget.kind` | `disabled` or `limited` |
| `maxEstimatedCostUsd` | Number 0.000001–100,000 for `limited` |
| `maxConcurrency` | Integer 1–1,024 |
| `maxBatchSize` | Integer 1–10,000 |

## Targets

Every target contains `kind`, `adapter`, and `settings`. `settings` defaults to
`{}` and must be a bounded JSON object. Secret-looking setting keys are sanitized
to environment references during rendering; putting credentials in the canonical
file is still prohibited because source control retains the original value.

### Coding agent

```yaml
- kind: coding-agent
  adapter: claude-code
  features:
    - instructions
    - skills
    - subagents
    - hooks
    - mcp
  settings: {}
```

Features are unique values from `instructions`, `skills`, `subagents`, `hooks`,
`mcp`, `permissions`, and `headless`. Built-in coding-agent adapters are
`claude-code`, `codex`, and `grok-build`. The field records requested/native
capability intent; the selected adapter remains responsible for its deterministic
artifact contract.

Claude Code passes sanitized settings through to `.claude/settings.json` and
merges registered hooks. Codex and Grok Build currently need no target-specific
settings.

### Chat plugin

```yaml
- kind: chat-plugin
  adapter: chatgpt
  settings:
    name: Example assistant
    version: 1.0.0
    description: Repository-local engineering assistant
```

The built-in ChatGPT adapter interprets optional non-empty string settings
`name`, `version`, and `description`. Their fallbacks are the project name,
`1.0.0`, and `<project> project assistant` respectively.

### API provider

```yaml
- kind: api-provider
  adapter: xai-api
  protocol: responses
  settings: {}
```

`protocol` is `responses` or `chat-completions`. The built-in xAI adapter emits
the fixed xAI base URL and `XAI_API_KEY` environment-variable name, plus sanitized
settings; it never accepts a credential value as generated configuration.

### Inference gateway

```yaml
- kind: inference-gateway
  adapter: openrouter
  routing:
    kind: fixed
    model: openrouter/free
  settings:
    protocol: responses
```

The built-in gateway is `openrouter`. `settings.protocol` may explicitly select
`responses`; otherwise the wire-compatible default is `chat-completions`.
Generated configuration uses the fixed OpenRouter base URL and
`OPENROUTER_API_KEY` environment-variable name.

Routing is one of:

```yaml
routing:
  kind: fixed
  model: openrouter/free
```

```yaml
routing:
  kind: fallback
  models:
    - provider/primary-model
    - provider/backup-model
```

```yaml
routing:
  kind: capability
  requiredParameters:
    - tools
    - structured_outputs
  providerOrder:
    - openai
    - anthropic
    - xai
```

Fixed models are non-empty strings. Fallback models are a non-empty unique array.
Capability arrays contain unique non-blank strings; the built-in OpenRouter
verifier additionally requires a non-empty `providerOrder`.

## Packs

```yaml
packs:
  - engineering
```

Packs are unique registered extension IDs. The first-party `engineering` pack
contributes layered dependency, extension registry, rich domain model, lightweight
public API, architecture-review, and verification guidance. External packs must
be registered before planning.

## Generation

```yaml
generation:
  sourceDirectory: .aiyoke/source
  lockFile: .aiyoke/lock.json
  lineEndings: lf
```

Both paths must be safe relative paths. `lineEndings` is currently the literal
`lf`; platform-native or CRLF output is deliberately unsupported so artifacts
and digests remain reproducible across operating systems.

## Complete minimal configuration

```yaml
schemaVersion: 3
project:
  name: minimal
  architecture: layered
composition:
  kind: single
  stack:
    languages: []
    frameworks: []
runtime:
  kind: disabled
targets: []
packs: []
generation:
  sourceDirectory: .aiyoke/source
  lockFile: .aiyoke/lock.json
  lineEndings: lf
```

This parses, but `doctor` reports an error for no targets and a warning for no
languages. It is a schema example, not a recommended operational configuration.

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

Remove `--dry-run` to write. Flags replace their selected root lists while
preserving settings for targets that remain selected. A successful write first
creates a content-addressed recovery backup under `.aiyoke/backups`.

Run `aiyoke config` without editing flags to print canonical output without
writing. Run `aiyoke config --interactive` only from a terminal. Interactive
mode gathers and validates every answer, then asks for confirmation; cancellation,
invalid input, EOF, and non-TTY execution do not modify the source.

Detailed runtime policies, monorepo workspaces, target features/settings/routing,
generation paths, and target kinds are edited in reviewed YAML. Follow any manual
edit with `aiyoke plan` before `apply`.

## Migration

Normal commands never migrate silently. Preview and apply the complete adjacent
migration chain with:

```sh
aiyoke migrate --dry-run
aiyoke migrate
```

Use `--to <version>` to select a supported destination. Downgrades fail unless
`--allow-downgrade` is present, and a downgrade that cannot represent current
state—such as monorepo composition in schema 1 or a customized runtime policy in
schema 2—fails even with consent.

Every applied migration prints a content-addressed backup path. Restore it with:

```sh
aiyoke rollback --backup .aiyoke/backups/aiyoke.v1-<digest>.yaml --dry-run
aiyoke rollback --backup .aiyoke/backups/aiyoke.v1-<digest>.yaml
```

Rollback validates the backup and its migration path, creates a safety backup of
the current file, rechecks that the source did not change during preparation, and
writes atomically. Restoring an older schema intentionally requires running
`aiyoke migrate` before normal planning and generation resume.
