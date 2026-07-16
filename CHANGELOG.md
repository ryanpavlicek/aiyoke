# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-07-16

### Added

- Deterministic `init`, read-only `plan`, atomic/idempotent `apply`, `check`,
  `doctor`, `detect`, and `list` commands.
- Native target adapters for Claude Code, Codex, ChatGPT plugins, Grok Build,
  xAI/Grok API configuration, and OpenRouter routing.
- Registered language extensions for Python, TypeScript, JavaScript, Rust, and
  Go, with first-party modern framework extensions.
- Layered architecture enforcement, a lazy public facade, a versioned extension
  SDK, dependency-aware registry, and additional-extension injection.
- Content-addressed lock manifests, generated-artifact drift detection,
  ownership conflicts, stale-plan protection, atomic writes, and cross-platform
  path validation.
- CI for Node.js 22 and 24, governance files, ADRs, extension documentation, and
  the first-release acceptance suite.
- A five-stack dogfood matrix that exercises all six AI target surfaces for
  Python/FastAPI, TypeScript/Next.js, JavaScript/Express, Rust/Axum, and Go/Gin.
- Selective `init --targets` profiles and bounded managed-section merging that
  preserves user-authored content around generated instructions.
