export {
  type CompatibilityCheck,
  type CompatibilityCheckId,
  type CompatibilityFinding,
  type CompatibilityFixture,
  type CompatibilityReport,
  type CompatibilityRunOptions,
  runExtensionCompatibility
} from "./compatibility.js";
export {
  type AiyokeExtension,
  type CapabilityPackExtension,
  type ContributionContext,
  type DetectionResult,
  defineFramework,
  defineLanguage,
  definePack,
  defineRuntime,
  defineTarget,
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  type ExtensionDescriptorBase,
  type ExtensionKind,
  type ExtensionLoader,
  type ExtensionReference,
  type FrameworkExtension,
  type LanguageExtension,
  type RuntimeRenderContext,
  type RuntimeScope,
  type RuntimeTemplateExtension,
  type TargetExtension,
  type TargetRenderContext,
  type TargetVerificationContext,
  type WorkspaceSnapshot
} from "./contracts.js";
export { ExtensionRegistry } from "./registry.js";
export {
  type ExtensionConsent,
  type ExtensionTrustRoot,
  type ExtensionTrustStore,
  type ManifestCryptoPort,
  type ManifestRejectionReason,
  type ManifestVerificationResult,
  manifestSigningPayload,
  parseSignedExtensionManifest,
  type SignedExtensionDiscoveryOptions,
  type SignedExtensionDiscoveryResult,
  type SignedExtensionManifest,
  verifySignedExtensionManifest
} from "./signed-manifest.js";
