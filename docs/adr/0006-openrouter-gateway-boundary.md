# ADR 0006: Isolate OpenRouter behind an inference-gateway boundary

- Status: Accepted
- Date: 2026-07-16

## Context

OpenRouter exposes a useful multi-provider gateway, but model availability,
routing behavior, limits, and upstream error details can change independently of
this package. Treating a gateway as identical to a direct provider would erase
important lifecycle and routing distinctions.

## Decision

OpenRouter is a supported `inference-gateway` target. Its versioned generated
configuration uses declared routing policies, protocol selection, and an
environment-variable credential reference. Gateway verification reports invalid
or empty routes and does not silently rewrite the canonical specification.

## Consequences

The public domain model preserves the difference between a direct provider and a
gateway. External model availability remains OpenRouter-controlled, while aiyoke
keeps its generated contract deterministic and testable.
