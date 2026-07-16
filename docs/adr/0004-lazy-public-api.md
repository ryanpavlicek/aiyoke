# ADR 0004: Lazy public API

- Status: Accepted
- Date: 2026-07-16

## Context

Consumers often import types or core validation in tools that do not have a
workspace, filesystem adapter, or every optional target installed. Eagerly
importing the engine would make those lightweight uses pay for heavy modules and
increase startup/circular-dependency risk.

## Decision

`src/index.ts` statically exports only core and extension-SDK contracts. Engine,
infrastructure, interfaces, and extension implementations are reached through
dynamic imports or explicit composition APIs. The architecture checker rejects
static public-API imports of those heavy layers.

## Consequences

Import-time behavior is predictable and CLI startup can stay small. API methods
that need the engine are asynchronous, and callers must handle a lazy-load
failure at invocation time.
