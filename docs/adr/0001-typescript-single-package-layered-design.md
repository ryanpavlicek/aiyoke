# ADR 0001: TypeScript single-package layered design

- Status: Accepted
- Date: 2026-07-16

## Context

The harness compiler has a small domain model, multiple adapters, and a public
CLI/API. Splitting each layer into packages would add versioning and build
friction before the contracts are stable. A flat source tree, however, makes it
too easy for adapters to leak into the domain.

## Decision

Keep one npm package written in strict TypeScript and enforce explicit source
layers (`core`, `extension-sdk`, `application`, `infrastructure`, `engine`,
`interfaces`, and `extensions`). The architecture checker validates local
static imports in CI. Heavy modules are loaded behind dynamic-import boundaries.

## Consequences

Contributors get one install/build/test workflow and a single coherent release.
The package must keep boundaries clear and may eventually split a layer only
when independent release cadence or dependency isolation justifies it.
