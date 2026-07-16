# Repository Guidance

## Architecture

- Keep dependencies flowing downward: interfaces and adapters may depend on application
  code; application code and the extension SDK may depend on core; core depends on no
  higher layer.
- Do not import Node.js filesystem, network, YAML, CLI, or target-specific modules from
  `src/core/`.
- Add capabilities through `ExtensionRegistry`; do not add target or framework switch
  statements to the core.
- Model variants and lifecycle stages with discriminated unions and composition.
- Keep `src/index.ts` lightweight. Heavy modules must be loaded through dynamic imports.

## Engineering

- Preserve deterministic ordering and idempotence in all generated artifacts.
- Reject unsafe paths, duplicate extension IDs, dependency cycles, and conflicting
  artifact ownership.
- Never write secrets into generated files. Use environment-variable references.
- Add or update tests for behavior changes and run `pnpm check` before handoff.
- Do not edit user-owned sections of repository files without an explicit managed marker.

