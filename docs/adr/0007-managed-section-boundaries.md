# ADR 0007: Preserve shared instruction files with bounded managed sections

- Status: Accepted
- Date: 2026-07-16

## Context

Repository-root instruction files such as `AGENTS.md` and `CLAUDE.md` are
shared surfaces. Developers may maintain durable project guidance
in the same files that AI tools consume. Whole-file generation would overwrite
that guidance, while treating the files as entirely user-owned would prevent
aiyoke from updating its projection.

## Decision

`ArtifactIntent` represents managed sections as a distinct domain variant with
explicit start and end markers. Planning follows these rules:

1. If the file does not exist, create a bounded generated section.
2. If the file exists without reserved markers, append the bounded section and
   preserve the existing bytes.
3. If exactly one ordered marker pair exists, replace only its contents.
4. If markers are missing, duplicated, nested ambiguously, or present in
   generated content, report a conflict and perform no writes.
5. Revalidate the complete previous file during stale-plan preflight before
   applying any operation.

The lock manifest hashes the intended generated section rather than surrounding
user content. The concrete merged file remains part of the plan fingerprint and
stale-write check.

## Consequences

Developers can safely share root instruction files with generated harnesses.
Extensions must declare marker metadata for managed-section artifacts, and the
planner carries the small additional responsibility of deterministic bounded
merging. Ambiguous legacy or malformed state requires an explicit user decision
instead of a destructive guess.
