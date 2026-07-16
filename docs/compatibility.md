# Compatibility matrix

The first release supports a deliberately bounded set of AI surfaces and
application stacks. Support means a registered extension can detect or resolve
the declared input, contribute typed harness modules, render deterministic native
artifacts, and participate in drift verification.

## AI targets

| Target | Domain surface | Primary generated artifacts |
| --- | --- | --- |
| Claude Code | `coding-agent` | `CLAUDE.md`, `.claude/agents`, `.claude/skills`, optional hooks and MCP configuration |
| Codex | `coding-agent` | `AGENTS.md`, `.agents/skills` |
| ChatGPT | `chat-plugin` | `.agents/plugins/marketplace.json`, versionable `.codex-plugin` plugin root |
| Grok Build | `coding-agent` | `AGENTS.md`, `.grok/skills`, optional `.grok/hooks` and `.grok/config.toml` |
| xAI/Grok API | `api-provider` | `.xai/provider.json` with an `XAI_API_KEY` environment reference |
| OpenRouter | `inference-gateway` | `.openrouter/config.json` with routing policy and an `OPENROUTER_API_KEY` environment reference |

## Languages and frameworks

| Language | First-party framework extensions |
| --- | --- |
| Python | FastAPI, Django, Flask |
| TypeScript | Next.js, NestJS, Fastify, Express |
| JavaScript | Next.js, Fastify, Express |
| Rust | Axum, Actix Web |
| Go | Chi, Gin, Fiber |

Framework detection requires dependency or distinctive marker evidence. A generic
manifest alone does not select a framework.

## Dogfood acceptance matrix

CI runs the full six-target lifecycle against five representative fixtures:

| Fixture | Detection expectation |
| --- | --- |
| Python + FastAPI | `python`, `fastapi` |
| TypeScript + Next.js | `typescript`, `nextjs` |
| JavaScript + Express | `javascript`, `express` |
| Rust + Axum | `rust`, `axum` |
| Go + Gin | `go`, `gin` |

For each fixture, the suite verifies detection, initialization, conflict-free
planning, generation of all target surfaces, language/framework instruction
composition, environment-only credential references, drift checking, and a
zero-write second apply. These fixtures validate aiyoke's compilation contract;
they do not replace running each framework's own build and test toolchain in a
real consuming repository.
