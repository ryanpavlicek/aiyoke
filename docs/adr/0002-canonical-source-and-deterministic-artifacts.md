# ADR 0002: Canonical source and deterministic artifacts

- Status: Accepted
- Date: 2026-07-16

## Context

Each supported host has a different file format, but users need one reviewable
configuration and repeatable plans. Treating generated files as configuration
would make drift and ownership ambiguous.

## Decision

The versioned harness specification is canonical. Discovery, resolution, plan,
apply, and verification form an explicit lifecycle. Renderers emit sorted,
LF-normalized `ArtifactIntent` values with explicit ownership and a stable plan
fingerprint. Writes are safe, atomic, and idempotent; user-owned files are not
overwritten without a managed marker.

## Consequences

Reviewers can inspect one source document and reproduce output. Renderers need
more discipline, and target-specific state must be represented as a projection
or verification finding rather than silently becoming a second source of truth.
