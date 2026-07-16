import { extensionId, type HarnessModule } from "../../core/index.js";
import {
  type CapabilityPackExtension,
  definePack,
  type ExtensionLoader
} from "../../extension-sdk/index.js";

export const engineeringPack: CapabilityPackExtension = definePack({
  descriptor: {
    kind: "pack",
    id: extensionId("engineering"),
    version: "1.0.0",
    apiVersion: "1.0.0",
    displayName: "Engineering foundations",
    description: "Layering, extension points, domain modeling, and lightweight public APIs.",
    capabilities: ["architecture", "review", "verification"],
    requires: [],
    conflicts: []
  },
  async contribute(): Promise<HarnessModule> {
    return {
      id: "pack-engineering",
      title: "Engineering foundations",
      source: "engineering",
      instructions: [
        {
          kind: "always",
          id: "downward-dependencies",
          title: "Layered architecture with clear downward dependencies",
          body: [
            "Keep the stable domain/core layer at the bottom and free of application, adapter, controller, pipeline, or framework dependencies.",
            "Direct dependencies downward: interfaces and infrastructure depend on application ports; application depends on core and extension contracts; core depends on nothing higher.",
            "Reject circular dependencies and imports that let a lower layer reach into a higher layer."
          ]
        },
        {
          kind: "always",
          id: "extension-registry",
          title: "Plugin and extension registry",
          body: [
            "Add providers, adapters, behaviors, languages, and frameworks through registration points instead of branching in core logic.",
            "Keep extension contracts stable and make registration deterministic, duplicate-safe, and independently testable."
          ]
        },
        {
          kind: "always",
          id: "rich-domain-model",
          title: "Rich but flexible domain models",
          body: [
            "Represent variants and lifecycle stages with composition, enums, and discriminated unions instead of one interface with many optional fields.",
            "Preserve meaningful distinctions at boundaries and validate external data before it enters the domain."
          ]
        },
        {
          kind: "always",
          id: "lightweight-public-api",
          title: "Lightweight public API",
          body: [
            "Keep public entry points intentional and small; expose common contracts directly and load heavy or optional subsystems lazily behind facades.",
            "Avoid broad barrel exports and use dynamic imports where they prevent startup cost or circular dependencies."
          ]
        }
      ],
      skills: [
        {
          name: "architecture-review",
          description: "Review dependency direction, extension boundaries, and domain modeling.",
          body: "Inspect the changed dependency graph. Confirm dependencies point toward the core, new capabilities register through extension points, domain variants remain explicit, and the public surface stays minimal. Report concrete findings with file paths before suggesting changes.",
          userInvocable: true,
          allowedTools: ["read", "search", "test"]
        },
        {
          name: "verify-change",
          description: "Run proportionate static checks and focused tests for a change.",
          body: "Identify the narrowest relevant checks, run static analysis and focused tests, then expand to the repository verification command. Report failures with their likely cause and do not claim success without command evidence.",
          userInvocable: true,
          allowedTools: ["read", "search", "test"]
        }
      ],
      hooks: [],
      mcpServers: [],
      subagents: [
        {
          name: "architecture-reviewer",
          description: "Read-only reviewer for dependency and extension design.",
          prompt:
            "Review the proposed change for downward dependency direction, extension registry use, rich domain modeling, and public API weight. Return only evidence-backed findings.",
          tools: ["read", "search"],
          readOnly: true
        }
      ]
    };
  }
});

export function createEngineeringPackLoader(): ExtensionLoader<typeof engineeringPack> {
  return { descriptor: engineeringPack.descriptor, load: async () => engineeringPack };
}

export const engineeringPackLoader = createEngineeringPackLoader();
