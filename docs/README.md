# Documentation map

Aiyoke documentation is organized by the job you are trying to complete. The
root [README](../README.md) is the product overview and shortest installation
path; this page routes to the deeper contracts that ship with the npm package.

## First use

1. Follow the root [five-minute setup](../README.md#five-minute-setup).
2. Work through the executable [Next.js quickstart](../examples/quickstart-nextjs/README.md).
3. Use the [CLI reference](cli.md) when moving from the tutorial to automation.
4. Check the [compatibility matrix](compatibility.md) before selecting targets,
   languages, frameworks, or provider behavior.

## Configure and operate a repository

- [Configuration, migration, and recovery](configuration.md) is the exhaustive
  schema-v3 field, default, constraint, target, runtime-policy, migration, and
  rollback reference.
- [CLI reference](cli.md) covers commands, flags, write behavior, output, and exit
  codes.
- [Troubleshooting](troubleshooting.md) maps common errors to safe recovery steps.
- [Production runtime harness contract](runtime-harness-contract.md) explains
  what generated reliability, observability, evaluation, safety, portability,
  and cost/performance support means.

## Extend or embed Aiyoke

- [Public API reference](api.md) documents every supported package entry point,
  export family, method, option, result union, and error contract.
- [Extension authoring](extensions.md) covers descriptors, loaders,
  compatibility, signed discovery, trust, and renderer isolation.
- The [external hello target](../examples/extensions/hello-target/README.md) is a
  complete out-of-tree extension package.
- [Architecture](architecture.md) and the [ADRs](adr/) define dependency
  direction, canonical output, registries, lazy loading, trust, and ownership.

## Contribute and maintain

- [Contributing](../CONTRIBUTING.md) covers setup, repository layers, development
  commands, change recipes, test expectations, and pull requests.
- [Security policy](../SECURITY.md) defines private reporting, supported
  versions, and the threat model.
- [Release readiness](release-readiness.md) records the acceptance evidence for
  the public 0.3 line.
- [Release operations](releasing.md) covers protected publishing, verification,
  deprecation, and rollback.
- [Roadmap](roadmap.md) separates completed contracts from later exploration.

## Documentation verification

`pnpm test:docs` validates Markdown discovery, balanced code fences, relative
links, reference links, local anchors, safe external URL syntax, and required
navigation. Executable tests run the quickstart lifecycle and compare the CLI
help contract with the documented commands. `pnpm test:docs:external` adds a
bounded live availability check; GitHub runs it weekly so transient remote-site
failures do not block ordinary pull requests.
