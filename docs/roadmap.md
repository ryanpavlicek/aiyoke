# Release roadmap

The roadmap is acceptance-gated: each release ships only when its invariants,
fixtures, security checks, distribution checks, and documentation are complete.
Version 0.3 is the first public-ready release. Version 1.0 stabilizes contracts
after public field use rather than serving as the first usable build. See
`docs/release-readiness.md` for the evidence required at each gate.

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
- Add deterministic interactive and non-interactive configuration editing.
- Add versioned, reversible schema migration commands and fixtures.
- Add extension compatibility fixtures and a standalone compatibility runner.
- Add property-based and adversarial coverage for configuration, paths,
  extension graphs, artifact ownership, and filesystem boundaries.
- Define a provider-neutral runtime-harness domain contract and generate the
  first reliability, observability, evaluation, safety, and budget primitives.

## 0.3 — extension ecosystem

- Add signed third-party extension discovery without expanding core dependencies.
- Publish extension-authoring examples and a standalone compatibility test harness.
- Add optional process isolation for untrusted third-party renderers.
- Complete cross-platform CI/CD, package provenance, release rollback, security
  review, installation verification, and public documentation.
- Verify every promised AI target, language, and framework through reproducible
  compatibility evidence before publishing.
- Complete and verify the seven production runtime capability families in
  `docs/runtime-harness-contract.md` across supported language templates.

## 1.0 — stable contracts

- Freeze the schema and extension SDK compatibility policy.
- Define support windows for Node and pnpm, and publish migration guidance.
- Promote integrations only after reproducible fixtures, verification coverage,
  and security review meet the release checklist.

## Later exploration

Potential follow-up work includes a signed extension index, optional process
sandboxing, remote/workspace adapters, and additional target surfaces. These are
not prerequisites for the canonical-source and deterministic-artifact contract.
