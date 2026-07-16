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

## 1. Reliability and robustness

Generated runtime templates must provide:

- bounded retries with explicit retryability, backoff, jitter, and attempt limits;
- deadlines, cancellation, fallbacks, and a circuit-breaker state machine;
- schema-based structured-output validation with bounded repair attempts;
- typed failure categories and deliberate graceful-degradation policies; and
- deterministic tests for time, concurrency, malformed output, and exhausted paths.

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

## 4. Safety and control

Generated runtime templates must provide composable input, tool, and output guard
registries; policy decisions and redacted audit events; and an explicit
human-approval lifecycle for configured high-impact actions. Application policy
remains separate from provider adapters and cannot be silently bypassed by a
fallback route.

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

Framework support means a thin integration example and verified request lifecycle,
not a copy of the runtime for every framework. Target support means native
developer-plane artifacts and provider configuration appropriate to that target;
it does not imply that desktop coding clients become production inference APIs.
