import type { ExtensionId } from "./identity.js";
import type { JsonObject } from "./json.js";

export type ProjectArchitecture = "layered" | "hexagonal" | "clean" | "custom";

export interface ProjectIdentity {
  readonly name: string;
  readonly architecture: ProjectArchitecture;
}

export interface HarnessStack {
  readonly languages: readonly ExtensionId[];
  readonly frameworks: readonly ExtensionId[];
}

export type AgentFeature =
  | "instructions"
  | "skills"
  | "subagents"
  | "hooks"
  | "mcp"
  | "permissions"
  | "headless";

export interface CodingAgentTarget {
  readonly kind: "coding-agent";
  readonly adapter: ExtensionId;
  readonly features: readonly AgentFeature[];
  readonly settings: JsonObject;
}

export interface ChatPluginTarget {
  readonly kind: "chat-plugin";
  readonly adapter: ExtensionId;
  readonly settings: JsonObject;
}

export interface ApiProviderTarget {
  readonly kind: "api-provider";
  readonly adapter: ExtensionId;
  readonly protocol: "responses" | "chat-completions";
  readonly settings: JsonObject;
}

export type RoutePolicy =
  | { readonly kind: "fixed"; readonly model: string }
  | { readonly kind: "fallback"; readonly models: readonly string[] }
  | {
      readonly kind: "capability";
      readonly requiredParameters: readonly string[];
      readonly providerOrder: readonly string[];
    };

export interface InferenceGatewayTarget {
  readonly kind: "inference-gateway";
  readonly adapter: ExtensionId;
  readonly routing: RoutePolicy;
  readonly settings: JsonObject;
}

export type TargetSpec =
  | CodingAgentTarget
  | ChatPluginTarget
  | ApiProviderTarget
  | InferenceGatewayTarget;

export interface GenerationPolicy {
  readonly sourceDirectory: string;
  readonly lockFile: string;
  readonly lineEndings: "lf";
}

export interface HarnessSpec {
  readonly schemaVersion: 1;
  readonly project: ProjectIdentity;
  readonly stack: HarnessStack;
  readonly targets: readonly TargetSpec[];
  readonly packs: readonly ExtensionId[];
  readonly generation: GenerationPolicy;
}

export type InstructionBlock =
  | {
      readonly kind: "always";
      readonly id: string;
      readonly title: string;
      readonly body: readonly string[];
    }
  | {
      readonly kind: "path-scoped";
      readonly id: string;
      readonly title: string;
      readonly paths: readonly string[];
      readonly body: readonly string[];
    };

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly userInvocable: boolean;
  readonly allowedTools: readonly string[];
}

export interface HookDefinition {
  readonly id: string;
  readonly event: "session-start" | "pre-tool" | "post-tool" | "stop";
  readonly command: string;
  readonly matcher?: string;
}

export interface McpServerDefinition {
  readonly name: string;
  readonly transport:
    | {
        readonly kind: "stdio";
        readonly command: string;
        readonly args: readonly string[];
      }
    | {
        readonly kind: "http";
        readonly url: string;
        readonly bearerTokenEnvironmentVariable?: string;
      };
}

export interface SubagentDefinition {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly readOnly: boolean;
}

export interface HarnessModule {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly instructions: readonly InstructionBlock[];
  readonly skills: readonly SkillDefinition[];
  readonly hooks: readonly HookDefinition[];
  readonly mcpServers: readonly McpServerDefinition[];
  readonly subagents: readonly SubagentDefinition[];
}

export type ArtifactOwnership = "generated" | "managed-section" | "user-owned";

interface ArtifactIntentBase {
  readonly path: string;
  readonly content: string;
  readonly source: string;
  readonly executable: boolean;
}

export interface ManagedSectionMarkers {
  readonly start: string;
  readonly end: string;
}

export type ArtifactIntent =
  | (ArtifactIntentBase & { readonly ownership: "generated" })
  | (ArtifactIntentBase & { readonly ownership: "user-owned" })
  | (ArtifactIntentBase & {
      readonly ownership: "managed-section";
      readonly markers: ManagedSectionMarkers;
    });

export type PlanOperation =
  | { readonly kind: "create"; readonly artifact: ArtifactIntent }
  | { readonly kind: "update"; readonly artifact: ArtifactIntent; readonly previous: string }
  | { readonly kind: "unchanged"; readonly artifact: ArtifactIntent }
  | {
      readonly kind: "conflict";
      readonly path: string;
      readonly reason: string;
      readonly sources: readonly string[];
    };

export interface HarnessPlan {
  readonly spec: HarnessSpec;
  readonly operations: readonly PlanOperation[];
  readonly fingerprint: string;
}

export interface VerificationFinding {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly target?: string;
}

export type HarnessLifecycle =
  | { readonly state: "discovered"; readonly spec: HarnessSpec }
  | {
      readonly state: "resolved";
      readonly spec: HarnessSpec;
      readonly modules: readonly HarnessModule[];
    }
  | { readonly state: "planned"; readonly plan: HarnessPlan }
  | {
      readonly state: "applied";
      readonly plan: HarnessPlan;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly state: "verified";
      readonly plan: HarnessPlan;
      readonly findings: readonly VerificationFinding[];
    }
  | { readonly state: "failed"; readonly reason: string };
