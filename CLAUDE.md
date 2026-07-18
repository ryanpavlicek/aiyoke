# Claude Code repository guidance

@CONTRIBUTING.md

- Preserve the downward dependency rules and extension registry described in the
  contributor guide.
- Keep public entry points lazy, generated output deterministic, and user-owned
  sections untouched.
- Add behavior tests for every change and run `pnpm check` before handoff.
- Use project-local skills for repeatable workflows and hooks only for deterministic
  enforcement.
