# ADR 0003: Extension registry and versioned contracts

- Status: Accepted
- Date: 2026-07-16

## Context

Adding a target through a switch in the core would make every new integration a
core change. Extensions also need dependency, conflict, and compatibility
validation before they can contribute artifacts.

## Decision

All capabilities enter through `ExtensionRegistry` and the stable
`extension-sdk` contracts. Descriptors carry a stable ID, semantic version, API
version, requirements, conflicts, and declared capabilities. Registration is
unique and mutable only until `freeze()`. Freeze validates the dependency graph;
resolution is deterministic and loader promises are memoized.

## Consequences

New integrations are isolated and can be tested independently. The SDK is a
public compatibility surface: breaking changes need an API version decision,
and metadata must remain honest because the registry is validation, not a
security sandbox.
