import { safeRelativePath } from "../core/index.js";

export const RUNTIME_CAPABILITY_FAMILY_IDS = [
  "reliability",
  "observability",
  "evaluation-and-iteration",
  "safety-and-control",
  "developer-experience-and-consistency",
  "maintainability-and-portability",
  "cost-and-performance"
] as const;

export type RuntimeCapabilityFamilyId = (typeof RUNTIME_CAPABILITY_FAMILY_IDS)[number];

export interface ImplementedCapabilityComponent {
  readonly kind: "implemented";
  readonly behaviors: readonly string[];
  readonly acceptanceArtifacts: readonly string[];
}

export interface IntegrationPortCapabilityComponent {
  readonly kind: "integration-port";
  readonly contract: string;
  readonly templateArtifacts: readonly string[];
  readonly acceptanceArtifacts: readonly string[];
}

export interface RuntimeCapabilityFamily {
  readonly id: RuntimeCapabilityFamilyId;
  readonly components: readonly [
    ImplementedCapabilityComponent,
    IntegrationPortCapabilityComponent
  ];
}

export interface RuntimeCapabilityManifest {
  readonly schemaVersion: 1;
  readonly language: string;
  readonly families: readonly RuntimeCapabilityFamily[];
}

export interface RuntimeCapabilityValidationContext {
  readonly language: string;
  readonly executedAcceptanceArtifacts: ReadonlySet<string>;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a canonical nonempty string.`);
  }
  return value;
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty array.`);
  }
  const strings = value.map((item, index) => nonemptyString(item, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${label} must not contain duplicates.`);
  }
  return strings;
}

function artifactPaths(value: unknown, label: string): readonly string[] {
  return uniqueStrings(value, label).map((path) => {
    const normalized = safeRelativePath(path);
    if (normalized !== path) {
      throw new TypeError(`${label} must use canonical forward-slash paths.`);
    }
    return normalized;
  });
}

function acceptancePaths(
  value: unknown,
  label: string,
  executed: ReadonlySet<string>
): readonly string[] {
  const paths = artifactPaths(value, label);
  for (const path of paths) {
    if (!executed.has(path)) {
      throw new TypeError(
        `${label} references an acceptance artifact that is not executed: ${path}.`
      );
    }
  }
  return paths;
}

export function validateRuntimeCapabilityManifest(
  value: unknown,
  context: RuntimeCapabilityValidationContext
): RuntimeCapabilityManifest {
  const manifest = record(value, "runtime capability manifest");
  if (manifest.schemaVersion !== 1) {
    throw new TypeError("runtime capability manifest schemaVersion must be 1.");
  }
  const expectedLanguage = nonemptyString(context.language, "expected language");
  if (manifest.language !== expectedLanguage) {
    throw new TypeError("runtime capability manifest language does not match its runtime.");
  }
  if (!Array.isArray(manifest.families)) {
    throw new TypeError("runtime capability manifest families must be an array.");
  }
  const familyIds = manifest.families.map(
    (family, index) => record(family, `families[${index}]`).id
  );
  if (JSON.stringify(familyIds) !== JSON.stringify(RUNTIME_CAPABILITY_FAMILY_IDS)) {
    throw new TypeError("runtime capability families must contain the exact ordered family set.");
  }
  const families = manifest.families.map((familyValue, familyIndex) => {
    const id = RUNTIME_CAPABILITY_FAMILY_IDS[familyIndex];
    if (id === undefined) {
      throw new TypeError(`families[${familyIndex}] is outside the supported family set.`);
    }
    const family = record(familyValue, `families[${familyIndex}]`);
    if (!Array.isArray(family.components) || family.components.length !== 2) {
      throw new TypeError(`families[${familyIndex}] must compose exactly two delivery variants.`);
    }
    const implemented = record(family.components[0], `families[${familyIndex}].components[0]`);
    const integrationPort = record(family.components[1], `families[${familyIndex}].components[1]`);
    if (implemented.kind !== "implemented" || integrationPort.kind !== "integration-port") {
      throw new TypeError(`families[${familyIndex}] delivery variants are invalid.`);
    }
    return {
      id,
      components: [
        {
          kind: "implemented" as const,
          behaviors: uniqueStrings(
            implemented.behaviors,
            `families[${familyIndex}].components[0].behaviors`
          ),
          acceptanceArtifacts: acceptancePaths(
            implemented.acceptanceArtifacts,
            `families[${familyIndex}].components[0].acceptanceArtifacts`,
            context.executedAcceptanceArtifacts
          )
        },
        {
          kind: "integration-port" as const,
          contract: nonemptyString(
            integrationPort.contract,
            `families[${familyIndex}].components[1].contract`
          ),
          templateArtifacts: artifactPaths(
            integrationPort.templateArtifacts,
            `families[${familyIndex}].components[1].templateArtifacts`
          ),
          acceptanceArtifacts: acceptancePaths(
            integrationPort.acceptanceArtifacts,
            `families[${familyIndex}].components[1].acceptanceArtifacts`,
            context.executedAcceptanceArtifacts
          )
        }
      ] as const
    };
  });
  return { schemaVersion: 1, language: expectedLanguage, families };
}
