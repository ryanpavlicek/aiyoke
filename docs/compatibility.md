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

Target artifacts are checked against a strict repository-owned contract on every
platform. CI additionally runs exact Claude Code and Codex npm CLI versions and an
exact Grok Build binary whose Linux and Windows SHA-256 values are pinned before execution. Grok's
machine-readable `inspect` command must discover the generated instructions and
skills; Claude must parse the generated project MCP entry; and Codex must discover
the generated ChatGPT marketplace. The pins live in
`scripts/target-client-versions.json` so compatibility changes are reviewed as
source changes rather than silently following `latest`.

When runtime generation is enabled, the selected stack also resolves one
registered application-runtime template for each language. Current generated
source uses only that language's standard library and includes registry-driven
provider ports, typed results and failures, deadlines and cancellation, bounded
retry/fallback and circuit breaking, validation and repair, redacted lifecycle
events, guards and approvals, cache/evaluation ports, token and cost budgets, and
bounded batch concurrency. CI executes the generated native test suites and runs
the applicable compilers, type checkers, and formatters. Selected frameworks also
receive registered thin request-lifecycle adapters; a clean CI fixture checks them
against pinned real releases of every framework in this matrix. Behavioral
fixtures execute every adapter with real framework request/response objects and
verify authorization propagation, success and typed-failure mapping, invalid
request handling, exception forwarding, and cancellation. Python exposes an
optional asynchronous cancellation-probe factory for Django/Flask servers that
cannot guarantee disconnect cancellation; Rust request factories return typed
`ExecuteOptions` so Axum/Actix applications can inject cancellation without a
framework dependency in the runtime core.

Every language also receives registered tooling and evaluation modules. Tooling
includes typed registration, input/output validation, approval, cancellation and
deadlines, panic/exception containment, and redacted event delivery. Evaluation
includes versioned suites, offline and deterministic sampled-online modes, bounded
concurrency, provider/scorer failure states, report delivery, baseline comparison,
and human feedback. External approval, telemetry, report storage, and feedback
systems connect through generated ports and native fake-backed contract tests.

Generated `capabilities.json` files enumerate all seven production families and
distinguish executable first-party behavior from endpoint/adapter/integration-port
delivery. Port-backed entries identify both their generated templates and native
acceptance artifacts; prose-only or placeholder support is not included.

Selecting OpenRouter or the xAI API emits registered Responses API adapters and
native mock tests in all five languages. TypeScript, JavaScript, Python, and Go
ship an HTTP implementation; Rust ships the stable transport port and adapter
template because its standard library has no HTTPS client. Live paid-provider
calls are excluded from default CI. The opt-in `pnpm test:live` command exercises
the generated OpenRouter adapter with an environment-injected credential. All
five native suites reject malformed and oversized responses; the Rust transport
port carries and verifies the same byte-limit contract without selecting a TLS
crate.

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
