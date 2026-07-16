# Security policy

Report suspected vulnerabilities privately through this repository's GitHub
security advisory feature. Include affected versions, impact, reproduction steps,
and any proposed mitigation. Do not open a public issue for an unpatched flaw or
include real credentials, private prompts, or sensitive generated artifacts.

Maintainers will acknowledge a complete report as soon as practical, validate its
scope, coordinate a fix and advisory, and credit reporters who want attribution.
There is no public bug-bounty promise.

## Supported versions

Before 0.3.1, only the current `main` release candidate receives security fixes.
After 0.3.1, the latest minor release receives fixes; older minors may be asked to
upgrade unless an announced support window says otherwise.

## Threat model

Aiyoke treats canonical configuration, workspace paths and contents, templates,
extension manifests and packages, renderer output, hooks, MCP configuration, and
provider responses as untrusted input. It validates bounded input, rejects unsafe
paths and symlink traversal, stages atomic writes under a verified real parent,
and never executes generated hooks during generation.

Credentials are environment-only. They must not appear in specifications, lock
files, generated artifacts, fixtures, snapshots, exception text, or lifecycle
events. Default tests use fakes; the opt-in live smoke prints only bounded token
counts and never prompt, response, or key values.

Signed extension discovery establishes package integrity and an approved
publisher identity. It does not prove code is safe. Optional child-process
renderer isolation removes host secrets, bounds serialized input/output,
deadlines, artifacts, and V8 heap, and fails closed on protocol errors. It is not
an OS sandbox: code can still use resources available to its operating-system
user. Run genuinely untrusted extensions in a container, VM, or equivalent
filesystem/network sandbox.

Release artifacts are built in GitHub Actions, checked as exact tarballs,
checksummed, accompanied by an SBOM, and published through npm trusted publishing
and a protected environment. See `docs/releasing.md` for verification, deprecation,
and incident rollback procedures.
