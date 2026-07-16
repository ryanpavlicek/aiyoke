import type { ArtifactIntent } from "../core/index.js";
import type { RuntimeRenderContext, TargetRenderContext } from "./contracts.js";
import type {
  ManifestRejectionReason,
  SignedExtensionDiscoveryOptions,
  SignedExtensionManifest
} from "./signed-manifest.js";

export const RENDERER_ISOLATION_PROTOCOL_VERSION = 1 as const;

export type IsolatedRenderInvocation =
  | { readonly kind: "target-render"; readonly context: TargetRenderContext }
  | { readonly kind: "runtime-render"; readonly context: RuntimeRenderContext };

export interface RendererIsolationLimits {
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxWorkspaceFiles?: number;
  readonly maxArtifacts?: number;
  readonly memoryMb?: number;
}

export interface IsolatedSignedExtensionOptions extends SignedExtensionDiscoveryOptions {
  readonly invocation: IsolatedRenderInvocation;
  readonly limits?: RendererIsolationLimits;
  readonly signal?: AbortSignal;
}

export type RendererIsolationRejectionReason =
  | "isolation-cancelled"
  | "isolation-failed"
  | "isolation-input-limit"
  | "isolation-output-limit"
  | "isolation-protocol"
  | "isolation-timeout"
  | "renderer-kind-mismatch";

export type IsolatedRendererResult =
  | {
      readonly kind: "rendered";
      readonly artifacts: readonly ArtifactIntent[];
      readonly manifest: SignedExtensionManifest;
      readonly manifestDigest: string;
      readonly contentDigest: string;
    }
  | {
      readonly kind: "consent-required";
      readonly manifest: SignedExtensionManifest;
      readonly manifestDigest: string;
      readonly keyId: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | ManifestRejectionReason
        | RendererIsolationRejectionReason
        | "manifest-invalid"
        | "package-invalid";
      readonly message: string;
      readonly manifestDigest?: string;
    };
