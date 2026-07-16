import {
  extensionId,
  type RuntimePolicy,
  resolveRuntimePolicy,
  safeRelativePath
} from "../../core/index.js";
import {
  defineRuntime,
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  type ExtensionLoader,
  type RuntimeTemplateExtension
} from "../../extension-sdk/index.js";

export interface RuntimeTemplateDefinition {
  readonly id: string;
  readonly language: string;
  readonly displayName: string;
  readonly fileName: string;
  readonly source: string;
  readonly testFileName: string;
  readonly testSource: string;
  readonly integrations?: readonly FrameworkIntegrationDefinition[];
  readonly providers?: readonly ProviderIntegrationDefinition[];
}

export interface FrameworkIntegrationDefinition {
  readonly framework: string;
  readonly path: string;
  readonly source: string;
}

export interface ProviderIntegrationDefinition {
  readonly targets: readonly string[];
  readonly artifacts: readonly IntegrationArtifactDefinition[];
}

export interface IntegrationArtifactDefinition {
  readonly path: string;
  readonly source: string;
}

function readme(
  definition: RuntimeTemplateDefinition,
  integrations: readonly FrameworkIntegrationDefinition[],
  providers: readonly ProviderIntegrationDefinition[],
  selectedTargets: ReadonlySet<string>
): string {
  const integrationGuidance =
    integrations.length === 0
      ? "No framework integration was selected for this scope."
      : `Selected framework integrations: ${integrations
          .map((integration) => `\`${integration.framework}\``)
          .join(
            ", "
          )}. Thin adapters are under \`integrations/\` and depend on the stable runtime facade.`;
  const providerGuidance =
    providers.length === 0
      ? "No inference provider adapter was selected for this scope."
      : `Selected provider integration targets: ${[
          ...new Set(
            providers
              .flatMap((provider) => provider.targets)
              .filter((target) => selectedTargets.has(extensionId(target)))
          )
        ]
          .map((target) => `\`${target}\``)
          .join(", ")}. Provider adapters resolve credentials through an injected secret port.`;
  return `# Aiyoke ${definition.displayName} runtime template

This generated directory is owned by Aiyoke. It contains an executable,
provider-neutral starting point plus the exact resolved policy in \`policy.json\`.

The runtime source defines typed request/failure state, provider and integration
ports, bounded retry timing, token/cost budget checks, and a circuit-breaker state
machine. Register application-specific provider, telemetry, cache, evaluation,
guard, and approval adapters at the application boundary.

The generated ${definition.testFileName} is a native conformance starting point.
Keep it running as the runtime is integrated and extend it with provider failure,
timeout, malformed-output, cancellation, and concurrency cases.

${integrationGuidance}

${providerGuidance}

Do not place credentials in this directory. Supply a secret resolver backed by
the environment or the consuming application's secret manager at runtime.
`;
}

function policyJson(policy: RuntimePolicy): string {
  return `${JSON.stringify({ schemaVersion: 1, policy }, undefined, 2)}\n`;
}

export function createRuntimeTemplate(
  definition: RuntimeTemplateDefinition
): RuntimeTemplateExtension {
  const language = extensionId(definition.language);
  const descriptor: ExtensionDescriptor & { readonly kind: "runtime" } = {
    kind: "runtime" as const,
    id: extensionId(definition.id),
    language,
    version: "1.0.0",
    apiVersion: EXTENSION_API_VERSION,
    displayName: definition.displayName,
    description: `Provider-neutral ${definition.displayName} production runtime primitives.`,
    capabilities: [
      "reliability",
      "observability",
      "evaluation",
      "safety",
      "provider-portability",
      "cost-control",
      "concurrency"
    ],
    requires: [{ kind: "language" as const, id: language }],
    conflicts: []
  };
  return defineRuntime({
    descriptor,
    async render({ spec, runtime, scope }) {
      const scopePrefix = scope.kind === "project" ? "" : `${scope.path}/`;
      const directory = safeRelativePath(
        `${scopePrefix}${runtime.outputDirectory}/${definition.language}`
      );
      const artifact = (fileName: string, content: string) => ({
        path: safeRelativePath(`${directory}/${fileName}`),
        content,
        ownership: "generated" as const,
        source: descriptor.id,
        executable: false
      });
      const selectedFrameworks = new Set(scope.stack.frameworks);
      const integrations = (definition.integrations ?? []).filter((integration) =>
        selectedFrameworks.has(extensionId(integration.framework))
      );
      const selectedTargets = new Set(spec.targets.map((target) => target.adapter));
      const providers = (definition.providers ?? []).filter((provider) =>
        provider.targets.some((target) => selectedTargets.has(extensionId(target)))
      );
      return [
        artifact(definition.fileName, definition.source),
        artifact(definition.testFileName, definition.testSource),
        artifact("policy.json", policyJson(resolveRuntimePolicy(runtime.profile))),
        artifact("README.md", readme(definition, integrations, providers, selectedTargets)),
        ...integrations.map((integration) => artifact(integration.path, integration.source)),
        ...providers.flatMap((provider) =>
          provider.artifacts.map((providerArtifact) =>
            artifact(providerArtifact.path, providerArtifact.source)
          )
        )
      ];
    }
  });
}

export function runtimeLoader<T extends RuntimeTemplateExtension>(runtime: T): ExtensionLoader<T> {
  return { descriptor: runtime.descriptor, load: async () => runtime };
}
