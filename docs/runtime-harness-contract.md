# Production runtime harness contract

Aiyoke is a template compiler, not a hosted model proxy. Its own CLI does not
retry model calls or collect application traces. It generates repository-local,
executable harness primitives and native AI-development artifacts so consuming
applications can do those things consistently.

This distinction creates two product planes:

- The developer plane configures Claude Code, ChatGPT/Codex, and Grok/Grok Build
  with native instructions, skills, hooks, and plugin metadata.
- The application plane generates provider-neutral runtime building blocks for
  Python, TypeScript, JavaScript, Rust, and Go. Provider and telemetry behaviors
  are adapters registered outside the stable runtime domain.

A capability is not complete merely because generated instructions recommend it.
The generated artifact must be executable, have stable configuration and error
contracts, and pass unit plus adversarial tests in a clean fixture.

Every capability is delivered in one of two ways: a working first-party primitive,
or a stable integration port accompanied by a useful reference adapter and
generated setup template. Stubs, TODOs, and prose-only recommendations do not
qualify as support. Services Aiyoke should not operate itself, such as a hosted
trace store or moderation backend, use the second form.

Each language output includes `capabilities.json`. Its seven discriminated family
entries list implemented behaviors separately from integration-port components,
including the contract name, generated template artifacts, and native acceptance
artifacts. This is the machine-readable support boundary used by compatibility
tests and available to downstream tooling.

### Delivery boundary

| Capability | Generated first-party behavior | External integration boundary |
| --- | --- | --- |
| Model execution | Retry, timeout, fallback, circuit breaking, validation, repair, routing, budgets | Registered model/provider adapter |
| Tools | Typed registry, validation, approval, deadline/cancellation, redacted events | Approval and event-sink ports |
| Evaluation | Versioned suites, deterministic sampling, concurrency, scoring, baseline regression | Report-sink and human-feedback ports |
| Observability | Correlated redacted lifecycle and tool events, latency, usage and cost fields | Event-sink/trace adapter port |
| Safety | Composable input/output guards plus validated tool input/output and fail-closed approval decisions | Moderation/policy adapters behind guard and approval ports |
| Caching | Cache keying and explicit cache outcomes in the runtime lifecycle | Registered cache port for an application-selected store |

The port is part of the generated source contract and is exercised with an
in-memory fake or reference adapter in native tests. No capability is claimed on
the strength of prose alone.

Configured caches emit redacted hit, miss, stored, read-failure, and write-failure
events. Cache and evaluation storage failures degrade without replacing a valid
model result. Guard and approval port failures fail closed with stable policy
failure categories; neither path includes backend error text in lifecycle events.

## 1. Reliability and robustness

Generated runtime templates must provide:

- bounded retries with explicit retryability, backoff, jitter, and attempt limits;
- deadlines, cancellation, fallbacks, and a circuit-breaker state machine;
- schema-based structured-output validation with bounded repair attempts;
- typed failure categories and deliberate graceful-degradation policies; and
- deterministic tests for time, concurrency, malformed output, and exhausted paths.

Native acceptance cases force both deadline expiry and caller cancellation through
the same adapter and require distinct `timeout` and `cancelled` outcomes. This
prevents an aborted request from being retried or reported as provider failure.

## 2. Observability

Generated runtime templates must emit correlated, redacted events for model
requests, tool calls, intermediate steps, and final outcomes. Adapters expose
traces, token usage, latency, estimated cost, retry/fallback decisions, and stable
failure categories without placing secrets or unrestricted prompt content in logs.

## 3. Evaluation and iteration

Generated runtime templates must support versioned prompts and configuration,
offline fixture evaluation, regression baselines, optional online sampling, and a
registered human-feedback port. Evaluation results must record enough immutable
metadata to reproduce the model, route, prompt, tools, and policy configuration.
Cancellation must remain distinguishable from deterministic sampling so aborted
cases are never reported as intentionally excluded.

## 4. Safety and control

Generated runtime templates must provide composable input/output guard registries,
a separate typed tooling registry with input/output validation, policy decisions
and redacted audit events, and an explicit human-approval lifecycle for configured
high-impact actions. Application policy remains separate from provider adapters
and cannot be silently bypassed by a fallback route.

## 5. Developer experience and consistency

Every supported language uses the same concepts and lifecycle while preserving
idiomatic APIs. Framework adapters connect request context, cancellation, auth,
and error handling to the shared language runtime rather than reimplementing it.
Examples cover single calls, structured generation, tools, routing, and evaluation.

## 6. Maintainability and portability

The stable domain depends on ports, not provider SDKs. Provider, cache, telemetry,
policy, and evaluation implementations register through extension points. Swapping
a provider or adding retrieval or agent orchestration must not require changing
application domain rules.

## 7. Cost and performance discipline

Generated runtime templates must support registered caches, configurable routing,
per-request and aggregate token/cost budgets, bounded batching, and concurrency
limits. Budget exhaustion and cache behavior are observable, deterministic under
test, and fail according to an explicit policy.

## Cross-language acceptance

The semantic contract is shared, but implementations remain idiomatic. TypeScript
and JavaScript may share one package implementation with distinct consumer
fixtures. Python, Rust, and Go have their own generated runtime modules. Each
language fixture must run its native formatter, compiler or type checker, unit
tests, and an adversarial conformance suite in CI.

Every native suite consumes one byte-identical, versioned `conformance.json` for
wire fields, provider failure classification, construction errors, guard stages,
and synchronous adapter failures. The resolved language-neutral policy also
generates a native `policy.*` options module, and tests pin millisecond units plus
circuit half-open limits so policy and executable defaults cannot drift.

The native fixture gate also validates each generated `capabilities.json` as a
closed acceptance matrix. It requires exactly these seven families, both composed
delivery variants, nonempty behavior and port contracts, safe existing template
paths without TODOs, and acceptance paths that are actually executed later in the
same native job. Dangling or documentation-only claims fail before compilation.

All languages generate separate stable runtime, tooling, evaluation, framework,
and provider modules. Dependencies flow downward: framework/provider/evaluation/
tooling modules import or compose the stable runtime contract; `runtime` never
imports them. Runtime module definitions are registered with the language
template, so adding a capability does not add provider or feature branching to
the core renderer.

Framework support means a thin integration example and verified request lifecycle,
not a copy of the runtime for every framework. Target support means native
developer-plane artifacts and provider configuration appropriate to that target;
it does not imply that desktop coding clients become production inference APIs.

## Provider integration boundary

Selecting `openrouter` or `xai-api` generates a registered Responses API adapter
for every selected runtime language. The adapter owns request/response mapping,
typed failures, retry classification, usage and estimated-cost extraction,
endpoint validation, and credential redaction. It receives credentials through
an injected secret resolver; generated code never loads `.env` or serializes a
secret into configuration.

TypeScript and JavaScript use the platform Fetch API, Python supplies a standard
library `urllib` transport, and Go supplies a standard `net/http` transport. Rust
defines a typed `ResponsesTransport` port and a complete registered adapter plus
executable fake-transport tests, leaving the consuming application free to use
`reqwest`, `ureq`, or its existing HTTP/TLS stack. Provider conformance tests use
local fakes or loopback servers and do not make paid external requests.

Provider response bodies are bounded before parsing and malformed JSON fails
closed with a stable code. Rust communicates the byte limit through its transport
request and requires the transport to report encoded response size. A separate
opt-in live smoke command generates and exercises the real JavaScript OpenRouter
adapter; it is excluded from normal CI and emits only non-secret usage counts.

Claude Code, ChatGPT/Codex, and Grok Build remain developer-plane clients. They
receive native configuration and workflow artifacts; they are not misrepresented
as interchangeable production inference endpoints.
