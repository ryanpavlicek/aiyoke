# Executable Next.js quickstart

This checked-in starter proves the complete first-user lifecycle against the
same public CLI used by the npm package. Repository tests copy `starter/` into a
temporary workspace and execute detection, initialization, read-only planning,
atomic application, verification, a zero-write second apply, deliberate drift,
and recovery. `expected-generated-paths.json` pins the key generated surface so
the tutorial cannot silently diverge from the product.

## 1. Create a disposable project

From an Aiyoke repository clone:

```sh
cp -R examples/quickstart-nextjs/starter ./aiyoke-quickstart-nextjs
cd aiyoke-quickstart-nextjs
npm install --save-dev aiyoke
```

The starter is deliberately small but valid enough for evidence-based
TypeScript/Next.js detection. Aiyoke does not need the application to build in
order to plan harness artifacts.

## 2. Inspect detection and initialize

```sh
npx aiyoke detect
npx aiyoke init \
  --languages typescript \
  --frameworks nextjs \
  --targets claude-code,codex,openrouter
```

`detect` should report `typescript` and `nextjs`. `init` creates only
`aiyoke.yaml`; it does not generate target or runtime files. Open that canonical
source before continuing. The selected target variants are Claude Code and Codex
coding agents plus the OpenRouter inference gateway; the default production
runtime and engineering pack remain enabled.

## 3. Review a read-only plan

```sh
npx aiyoke plan
```

The plan lists deterministic `create` operations and a fingerprint. It must not
write any generated artifact or lock file. Resolve every `conflict` before
applying; `apply` does not override ownership conflicts.

## 4. Apply and inspect the generated tree

```sh
npx aiyoke apply
```

The exact skill/runtime set can grow with registered contract changes, while the
following stable surface is pinned by the example test:

```text
.agents/skills/architecture-review/SKILL.md
.agents/skills/nextjs-route/SKILL.md
.agents/skills/typescript-review/SKILL.md
.agents/skills/verify-change/SKILL.md
.aiyoke/lock.json
.claude/agents/architecture-reviewer.md
.claude/skills/architecture-review/SKILL.md
.claude/skills/nextjs-route/SKILL.md
.claude/skills/typescript-review/SKILL.md
.claude/skills/verify-change/SKILL.md
.openrouter/config.json
AGENTS.md
CLAUDE.md
aiyoke-runtime/typescript/README.md
aiyoke-runtime/typescript/capabilities.json
aiyoke-runtime/typescript/integrations/nextjs.ts
aiyoke-runtime/typescript/modules/evaluation.test.ts
aiyoke-runtime/typescript/modules/evaluation.ts
aiyoke-runtime/typescript/modules/tooling.test.ts
aiyoke-runtime/typescript/modules/tooling.ts
aiyoke-runtime/typescript/policy.json
aiyoke-runtime/typescript/providers/responses.test.ts
aiyoke-runtime/typescript/providers/responses.ts
aiyoke-runtime/typescript/runtime.ts
aiyoke-runtime/typescript/runtime.test.ts
```

The generated runtime uses provider/tool/evaluation registries and ports; it does
not put an OpenRouter key in source. The provider configuration contains only the
`OPENROUTER_API_KEY` environment-variable name.

## 5. Verify idempotence

```sh
npx aiyoke check
npx aiyoke apply
```

`check` should have no error findings. The second apply prints `Already
synchronized; no changes made.` and performs zero writes.

## 6. Observe and recover from drift

Replace one generated file with known drift using a cross-platform Node command:

```sh
node -e "require('node:fs').writeFileSync('.openrouter/config.json', 'drift\n')"
npx aiyoke check
```

`check` now exits 1 with `GENERATED_DRIFT`. Review the repair plan, then restore
the owned artifact from the canonical source:

```sh
npx aiyoke plan
npx aiyoke apply
npx aiyoke check
```

The final check should pass. Do not edit `.aiyoke/lock.json` to conceal drift;
review and regenerate the affected artifact instead.

## 7. Continue safely

- Commit `aiyoke.yaml`, the lock file, and the generated artifacts your repository
  policy chooses to review.
- Inject `OPENROUTER_API_KEY` only in the consuming runtime's environment or
  secret resolver.
- Use [Configuration](../../docs/configuration.md) for target routing, runtime
  policies, monorepos, and recovery.
- Use [Troubleshooting](../../docs/troubleshooting.md) when a plan conflicts or a
  safety check refuses a path.
