# ADR 0005: Extension trust and secret handling

- Status: Accepted
- Date: 2026-07-16

## Context

Extensions can render executable hooks, invoke MCP servers, and access the local
workspace. The registry cannot provide a meaningful sandbox for arbitrary Node
modules. Provider credentials must also never leak into plans or generated files.

## Decision

Extensions are trusted-code dependencies. Documentation, review, pinned versions,
and explicit capability metadata are the trust boundary; the registry validates
identity and graph correctness only. Credentials are represented by environment
variable names and read at execution time. Logs, snapshots, plans, and artifacts
must redact values.

## Consequences

Users get an honest threat model and portable generated output, but installing an
unreviewed extension remains unsafe. Future sandboxing would be additive and
must not weaken the no-secrets invariant.
