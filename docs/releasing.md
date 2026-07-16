# Release operations

Aiyoke releases are immutable npm tarballs built from signed version tags. The
tag workflow validates source, builds one package artifact, installs and smokes
that exact tarball, generates a checksum and SPDX JSON SBOM, creates GitHub
provenance and SBOM attestations, and then waits for the protected `npm`
environment before publishing the same bytes.

## One-time repository and npm setup

1. Create a GitHub environment named `npm`. Require at least one maintainer
   reviewer, prevent self-review when the repository plan supports it, and limit
   deployment branches/tags to protected release tags.
2. Protect `main` and `v*` tags. Require the CI formatting/types/architecture,
   cross-platform test, coverage, package, security, native-runtime, and
   framework-runtime checks before merge.
3. On npmjs.com, configure `aiyoke` trusted publishing for GitHub Actions using
   owner `ryanpavlicek`, repository `aiyoke`, workflow `release.yml`, environment
   `npm`, and the `npm publish` action. Do not add a long-lived npm token to
   GitHub.
4. Require 2FA for maintainer account changes and manual package administration.
   Review npm and GitHub environment access at least quarterly.

The workflow grants `id-token: write` only to artifact attestation and publish
jobs. Release package-manager caches are disabled. npm trusted publishing uses a
short-lived workflow identity and automatically records npm provenance for a
public package built from this public repository.

## Prepare a release

1. Start from a clean clone of `main` and run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm test:target-clients
   pnpm test:runtimes
   pnpm test:frameworks
   pnpm test:package
   pnpm security:audit
   ```

2. Set the exact semantic version in `package.json`. Move relevant entries from
   `Unreleased` to a matching `## X.Y.Z` changelog heading and update compatibility
   or migration notes.
3. Run `node scripts/verify-release-version.mjs vX.Y.Z`. Review `npm pack
   --dry-run` and confirm no credential, `.env`, root `AGENTS.md`, source fixture,
   or build cache is included.
4. Merge the release preparation commit only after the complete CI workflow is
   green. Create and push a signed or otherwise protected `vX.Y.Z` tag at that
   exact commit. Never move or reuse a release tag.

The release workflow rejects a tag that does not exactly match `package.json`
and `CHANGELOG.md`. The protected `npm` environment is the final human approval
boundary. Reject the deployment if the package contents, checksum, SBOM, release
notes, or workflow provenance are unexpected.

## Verify a published release

Download the tarball and checksum from the GitHub release, then verify them:

```sh
node scripts/release-checksum.mjs verify aiyoke-X.Y.Z.tgz.sha256
gh attestation verify aiyoke-X.Y.Z.tgz -R ryanpavlicek/aiyoke
npm view aiyoke@X.Y.Z version dist.integrity repository
```

In a clean directory, install the exact version, import `aiyoke`,
`aiyoke/core`, and `aiyoke/extension-sdk`, and run `aiyoke --help`. Consumers can
run `npm audit signatures` with a current npm CLI to verify registry signatures
and npm provenance attestations.

## Failed publish

If artifact construction, attestation, or approval fails before npm publication,
do not reuse a partially created artifact. Fix the source, increment the version
when any package bytes change, and create a new tag. A failed workflow is not
authorization to publish a locally rebuilt tarball.

If npm publication succeeds but GitHub release creation fails, do not republish.
Verify the registry tarball and workflow artifact digest, then create the GitHub
release from the already attested workflow artifact. Record the incident in the
release notes.

## Rollback and deprecation

npm versions are immutable; rollback means containing the bad version and
shipping a forward fix, never overwriting it.

1. Pause release approvals and preserve the tag, workflow logs, checksum, SBOM,
   attestations, and affected tarball for investigation.
2. From a trusted maintainer workstation with 2FA, deprecate only the affected
   range with an actionable message:

   ```sh
   npm deprecate "aiyoke@X.Y.Z" "Known issue: upgrade to X.Y.(Z+1); see GHSA-or-issue"
   ```

3. Prepare a new patch release from a reviewed fix, rerun every gate, and publish
   through `release.yml`. Never point a tag at replacement bytes.
4. If a consumer's canonical configuration was migrated, use the reported
   content-addressed backup with `aiyoke rollback --backup <path>`, then install a
   known-good Aiyoke version. Preview both migration and rollback with `--dry-run`.
5. Use npm unpublish only when npm policy permits it and removal is necessary to
   prevent immediate harm. Unpublishing is not the normal rollback mechanism;
   deprecation plus a patched immutable version preserves dependent builds.

After recovery, add a regression test, document impact and affected versions,
rotate any exposed credential, and review whether trust roots, signed extension
digests, or publisher keys require revocation.
