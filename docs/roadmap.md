# Release roadmap

The roadmap is directional: each release is shipped only when its invariants,
fixtures, and documentation are complete. Dates beyond the implemented first
release are intentionally omitted.

## 0.1 — first release (current)

- Canonical harness schema with explicit target and lifecycle variants.
- Deterministic no-write planning, atomic/idempotent application, lock manifests,
  path/ownership checks, bounded managed-section merging, stale-plan protection,
  drift checking, and diagnostics.
- Registered target adapters for Claude Code, Codex, ChatGPT, Grok Build,
  xAI/Grok API, and OpenRouter.
- First-party language extensions for Python, TypeScript, JavaScript, Rust, and
  Go, plus their modern framework extensions.
- Enforced layered dependencies, a lazy public facade, CI, governance, extension
  authoring documentation, and architectural decisions.

## 0.2 — composition hardening

- Expand golden fixtures from representative projects into polyglot monorepos.
- Add interactive configuration editing and schema migration commands.
- Add extension compatibility fixtures and schema migration tooling.

## 0.3 — extension ecosystem

- Add signed third-party extension discovery without expanding core dependencies.
- Publish extension-authoring examples and a standalone compatibility test harness.
- Add optional process isolation for untrusted third-party renderers.

## 1.0 — stable contracts

- Freeze the schema and extension SDK compatibility policy.
- Define support windows for Node and pnpm, and publish migration guidance.
- Promote integrations only after reproducible fixtures, verification coverage,
  and security review meet the release checklist.

## Later exploration

Potential follow-up work includes a signed extension index, optional process
sandboxing, remote/workspace adapters, and additional target surfaces. These are
not prerequisites for the canonical-source and deterministic-artifact contract.
