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
  type RuntimeCapabilityManifest,
  type RuntimeTemplateExtension
} from "../../extension-sdk/index.js";
import { runtimeConformanceJson } from "./conformance.js";

export interface RuntimeTemplateDefinition {
  readonly id: string;
  readonly language: string;
  readonly displayName: string;
  readonly fileName: string;
  readonly source: string;
  readonly testFileName: string;
  readonly testSource: string;
  readonly policyArtifact: (policy: RuntimePolicy) => IntegrationArtifactDefinition;
  readonly modules?: readonly RuntimeModuleDefinition[];
  readonly integrations?: readonly FrameworkIntegrationDefinition[];
  readonly providers?: readonly ProviderIntegrationDefinition[];
}

export interface RuntimeModuleDefinition {
  readonly id: string;
  readonly description: string;
  readonly artifacts: readonly IntegrationArtifactDefinition[];
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
  modules: readonly RuntimeModuleDefinition[],
  integrations: readonly FrameworkIntegrationDefinition[],
  providers: readonly ProviderIntegrationDefinition[],
  selectedTargets: ReadonlySet<string>
): string {
  const moduleGuidance =
    modules.length === 0
      ? "No higher-level runtime modules were registered."
      : `Registered higher-level modules: ${modules
          .map((module) => `\`${module.id}\``)
          .join(", ")}. These modules depend downward on the stable runtime facade.`;
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

The adjacent runtime-native \`policy.*\` module is compiled from the same resolved
policy as \`policy.json\`; import its options rather than manually copying units or
defaults. The JSON document remains the language-neutral audit record.

The generated ${definition.testFileName} is a native conformance starting point.
Keep it running as the runtime is integrated and extend it with provider failure,
timeout, malformed-output, cancellation, and concurrency cases.

The versioned, language-neutral behavior contract is recorded in
\`conformance.json\`. Native tests load this file so the five generated runtimes
cannot silently redefine provider, wire-format, or option-validation semantics.

The machine-readable \`capabilities.json\` records all seven production capability
families and distinguishes executable first-party behavior from integration ports.

${integrationGuidance}

${providerGuidance}

${moduleGuidance}

Do not place credentials in this directory. Supply a secret resolver backed by
the environment or the consuming application's secret manager at runtime.
`;
}

function policyJson(policy: RuntimePolicy): string {
  return `${JSON.stringify({ schemaVersion: 1, policy }, undefined, 2)}\n`;
}

function capabilityManifest(
  definition: RuntimeTemplateDefinition,
  modules: readonly RuntimeModuleDefinition[],
  integrations: readonly FrameworkIntegrationDefinition[],
  providers: readonly ProviderIntegrationDefinition[],
  policyArtifactPath: string
): string {
  const moduleArtifacts = (id: string) =>
    modules
      .filter((module) => module.id === id)
      .flatMap((module) => module.artifacts.map(({ path }) => path));
  const providerArtifacts = providers.flatMap((provider) =>
    provider.artifacts.map(({ path }) => path)
  );
  const frameworkArtifacts = integrations.map(({ path }) => path);
  const runtimeAcceptance = [definition.testFileName];
  const manifest = {
    schemaVersion: 1,
    language: definition.language,
    families: [
      {
        id: "reliability",
        components: [
          {
            kind: "implemented",
            behaviors: [
              "bounded-retry",
              "deadline-and-cancellation",
              "fallback-routing",
              "circuit-breaking",
              "structured-output-validation-and-repair"
            ],
            acceptanceArtifacts: runtimeAcceptance
          },
          {
            kind: "integration-port",
            contract: "ModelAdapter and RepairPort",
            templateArtifacts: [definition.fileName],
            acceptanceArtifacts: runtimeAcceptance
          }
        ]
      },
      {
        id: "observability",
        components: [
          {
            kind: "implemented",
            behaviors: ["correlated-redacted-events", "latency-usage-and-cost", "cache-outcomes"],
            acceptanceArtifacts: runtimeAcceptance
          },
          {
            kind: "integration-port",
            contract: "EventSink",
            templateArtifacts: [definition.fileName, ...moduleArtifacts("tooling")],
            acceptanceArtifacts: [
              definition.testFileName,
              ...moduleArtifacts("tooling").filter((path) => path.includes("test"))
            ]
          }
        ]
      },
      {
        id: "evaluation-and-iteration",
        components: [
          {
            kind: "implemented",
            behaviors: ["versioned-suites", "deterministic-sampling", "baseline-regression"],
            acceptanceArtifacts: moduleArtifacts("evaluation").filter((path) =>
              path.includes("test")
            )
          },
          {
            kind: "integration-port",
            contract: "EvaluationReportSink and HumanFeedbackPort",
            templateArtifacts: moduleArtifacts("evaluation"),
            acceptanceArtifacts: moduleArtifacts("evaluation").filter((path) =>
              path.includes("test")
            )
          }
        ]
      },
      {
        id: "safety-and-control",
        components: [
          {
            kind: "implemented",
            behaviors: [
              "input-output-guards",
              "validated-tool-execution",
              "fail-closed-approval",
              "policy-audit-events"
            ],
            acceptanceArtifacts: [
              definition.testFileName,
              ...moduleArtifacts("tooling").filter((path) => path.includes("test"))
            ]
          },
          {
            kind: "integration-port",
            contract: "Guard, ApprovalPort, and validated tooling module",
            templateArtifacts: [definition.fileName, ...moduleArtifacts("tooling")],
            acceptanceArtifacts: [
              definition.testFileName,
              ...moduleArtifacts("tooling").filter((path) => path.includes("test"))
            ]
          }
        ]
      },
      {
        id: "developer-experience-and-consistency",
        components: [
          {
            kind: "implemented",
            behaviors: [
              "shared-lifecycle",
              "native-conformance-suite",
              "compiled-policy-options",
              "thin-framework-adapters"
            ],
            acceptanceArtifacts: [definition.testFileName, ...frameworkArtifacts]
          },
          {
            kind: "integration-port",
            contract: "Framework request factory",
            templateArtifacts: frameworkArtifacts.length > 0 ? frameworkArtifacts : ["README.md"],
            acceptanceArtifacts: [definition.testFileName]
          }
        ]
      },
      {
        id: "maintainability-and-portability",
        components: [
          {
            kind: "implemented",
            behaviors: [
              "adapter-registry",
              "provider-neutral-domain",
              "registered-provider-templates"
            ],
            acceptanceArtifacts: [
              definition.testFileName,
              ...providerArtifacts.filter((path) => path.includes("test"))
            ]
          },
          {
            kind: "integration-port",
            contract: "ModelAdapter, SecretResolver, and optional ResponsesTransport",
            templateArtifacts: [definition.fileName, ...providerArtifacts],
            acceptanceArtifacts: [
              definition.testFileName,
              ...providerArtifacts.filter((path) => path.includes("test"))
            ]
          }
        ]
      },
      {
        id: "cost-and-performance",
        components: [
          {
            kind: "implemented",
            behaviors: [
              "token-and-cost-budgets",
              "bounded-batching",
              "concurrency-limits",
              "cache-lifecycle"
            ],
            acceptanceArtifacts: runtimeAcceptance
          },
          {
            kind: "integration-port",
            contract: "CachePort",
            templateArtifacts: [definition.fileName, policyArtifactPath],
            acceptanceArtifacts: runtimeAcceptance
          }
        ]
      }
    ]
  } satisfies RuntimeCapabilityManifest;
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
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
      const modules = definition.modules ?? [];
      const integrations = (definition.integrations ?? []).filter((integration) =>
        selectedFrameworks.has(extensionId(integration.framework))
      );
      const selectedTargets = new Set(spec.targets.map((target) => target.adapter));
      const providers = (definition.providers ?? []).filter((provider) =>
        provider.targets.some((target) => selectedTargets.has(extensionId(target)))
      );
      const policy = resolveRuntimePolicy(runtime.profile);
      const nativePolicy = definition.policyArtifact(policy);
      return [
        artifact(definition.fileName, definition.source),
        artifact(definition.testFileName, definition.testSource),
        artifact("conformance.json", runtimeConformanceJson()),
        artifact("policy.json", policyJson(policy)),
        artifact(nativePolicy.path, nativePolicy.source),
        artifact(
          "capabilities.json",
          capabilityManifest(definition, modules, integrations, providers, nativePolicy.path)
        ),
        artifact(
          "README.md",
          readme(definition, modules, integrations, providers, selectedTargets)
        ),
        ...modules.flatMap((module) =>
          module.artifacts.map((moduleArtifact) =>
            artifact(moduleArtifact.path, moduleArtifact.source)
          )
        ),
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
