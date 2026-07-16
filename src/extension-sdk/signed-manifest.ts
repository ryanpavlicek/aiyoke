import { extensionId, safeRelativePath } from "../core/index.js";
import {
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  type ExtensionDescriptorBase,
  type ExtensionKind,
  type ExtensionLoader,
  type ExtensionReference
} from "./contracts.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface SignedExtensionManifest {
  readonly schemaVersion: 1;
  readonly extension: ExtensionDescriptor;
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly entrypoint: string;
    readonly exportName: string;
  };
  readonly content: { readonly algorithm: "sha256"; readonly digest: string };
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface ExtensionTrustRoot {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface ExtensionTrustStore {
  readonly roots: readonly ExtensionTrustRoot[];
  readonly revokedKeyIds: readonly string[];
  readonly revokedContentDigests: readonly string[];
  readonly revokedManifestDigests: readonly string[];
}

export type ExtensionConsent =
  | { readonly kind: "pending" }
  | { readonly kind: "denied" }
  | { readonly kind: "granted"; readonly manifestDigest: string };

export interface ManifestCryptoPort {
  sha256(value: string | Uint8Array): string;
  verifyEd25519(payload: string, signatureBase64: string, publicKeyPem: string): boolean;
}

export type ManifestRejectionReason =
  | "content-digest-mismatch"
  | "content-revoked"
  | "manifest-revoked"
  | "key-untrusted"
  | "key-revoked"
  | "signature-invalid"
  | "consent-denied"
  | "consent-mismatch";

export type ManifestVerificationResult =
  | {
      readonly kind: "trusted";
      readonly manifest: SignedExtensionManifest;
      readonly manifestDigest: string;
    }
  | {
      readonly kind: "consent-required";
      readonly manifest: SignedExtensionManifest;
      readonly manifestDigest: string;
      readonly keyId: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: ManifestRejectionReason;
      readonly message: string;
      readonly manifestDigest: string;
    };

export interface SignedExtensionDiscoveryOptions {
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly trust: ExtensionTrustStore;
  readonly consent: ExtensionConsent;
  readonly maxPackageBytes?: number;
  readonly maxPackageFiles?: number;
}

export type SignedExtensionDiscoveryResult =
  | {
      readonly kind: "loaded";
      readonly loader: ExtensionLoader;
      readonly manifest: SignedExtensionManifest;
      readonly manifestDigest: string;
      readonly contentDigest: string;
    }
  | Extract<ManifestVerificationResult, { readonly kind: "consent-required" }>
  | {
      readonly kind: "rejected";
      readonly reason:
        | ManifestRejectionReason
        | "manifest-invalid"
        | "package-invalid"
        | "module-invalid";
      readonly message: string;
      readonly manifestDigest?: string;
    };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function allowed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not supported.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length)
    throw new TypeError(`${label} must not contain duplicates.`);
  return value;
}

function reference(value: unknown, label: string): ExtensionReference {
  const item = record(value, label);
  allowed(item, ["kind", "id"], label);
  const kind = text(item.kind, `${label}.kind`) as ExtensionKind;
  if (!["target", "language", "framework", "pack", "runtime"].includes(kind)) {
    throw new TypeError(`${label}.kind is invalid.`);
  }
  return { kind, id: extensionId(text(item.id, `${label}.id`)) };
}

function references(value: unknown, label: string): readonly ExtensionReference[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const result = value.map((item, index) => reference(item, `${label}[${index}]`));
  const keys = result.map((item) => `${item.kind}:${item.id}`);
  if (new Set(keys).size !== keys.length)
    throw new TypeError(`${label} must not contain duplicates.`);
  return result;
}

function descriptor(value: unknown): ExtensionDescriptor {
  const item = record(value, "extension");
  const kind = text(item.kind, "extension.kind") as ExtensionKind;
  const keys = [
    "kind",
    "id",
    "version",
    "apiVersion",
    "displayName",
    "description",
    "capabilities",
    "requires",
    "conflicts",
    ...(kind === "runtime" ? ["language"] : [])
  ];
  allowed(item, keys, "extension");
  if (!["target", "language", "framework", "pack", "runtime"].includes(kind)) {
    throw new TypeError("extension.kind is invalid.");
  }
  if (item.apiVersion !== EXTENSION_API_VERSION) {
    throw new TypeError(`extension.apiVersion must be ${EXTENSION_API_VERSION}.`);
  }
  const base: ExtensionDescriptorBase = {
    id: extensionId(text(item.id, "extension.id")),
    version: text(item.version, "extension.version"),
    apiVersion: EXTENSION_API_VERSION,
    displayName: text(item.displayName, "extension.displayName"),
    description: text(item.description, "extension.description"),
    capabilities: stringArray(item.capabilities, "extension.capabilities"),
    requires: references(item.requires, "extension.requires"),
    conflicts: references(item.conflicts, "extension.conflicts")
  };
  if (!VERSION.test(base.version)) throw new TypeError("extension.version is invalid.");
  return kind === "runtime"
    ? { ...base, kind: "runtime", language: extensionId(text(item.language, "extension.language")) }
    : ({ ...base, kind } as ExtensionDescriptor);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function parseSignedExtensionManifest(source: string): SignedExtensionManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_MANIFEST_BYTES) {
    throw new RangeError(`Extension manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError("Extension manifest must be valid JSON.");
  }
  const root = record(parsed, "manifest");
  allowed(root, ["schemaVersion", "extension", "package", "content", "signature"], "manifest");
  if (root.schemaVersion !== 1) throw new TypeError("manifest.schemaVersion must be 1.");

  const packageValue = record(root.package, "package");
  allowed(packageValue, ["name", "version", "entrypoint", "exportName"], "package");
  const packageName = text(packageValue.name, "package.name");
  if (!PACKAGE_NAME.test(packageName)) throw new TypeError("package.name is invalid.");
  const packageVersion = text(packageValue.version, "package.version");
  if (!VERSION.test(packageVersion)) throw new TypeError("package.version is invalid.");
  const entrypoint = safeRelativePath(text(packageValue.entrypoint, "package.entrypoint"));
  const exportName = text(packageValue.exportName, "package.exportName");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new TypeError("package.exportName is invalid.");
  }

  const content = record(root.content, "content");
  allowed(content, ["algorithm", "digest"], "content");
  if (content.algorithm !== "sha256") throw new TypeError("content.algorithm must be sha256.");
  const contentDigest = text(content.digest, "content.digest");
  if (!DIGEST.test(contentDigest)) throw new TypeError("content.digest is invalid.");

  const signature = record(root.signature, "signature");
  allowed(signature, ["algorithm", "keyId", "value"], "signature");
  if (signature.algorithm !== "ed25519") {
    throw new TypeError("signature.algorithm must be ed25519.");
  }
  const keyId = text(signature.keyId, "signature.keyId");
  if (!KEY_ID.test(keyId)) throw new TypeError("signature.keyId is invalid.");
  const signatureValue = text(signature.value, "signature.value");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureValue)) {
    throw new TypeError("signature.value must be base64.");
  }

  return {
    schemaVersion: 1,
    extension: descriptor(root.extension),
    package: {
      name: packageName,
      version: packageVersion,
      entrypoint,
      exportName
    },
    content: { algorithm: "sha256", digest: contentDigest },
    signature: { algorithm: "ed25519", keyId, value: signatureValue }
  };
}

export function manifestSigningPayload(manifest: SignedExtensionManifest): string {
  return canonical({
    schemaVersion: manifest.schemaVersion,
    extension: manifest.extension,
    package: manifest.package,
    content: manifest.content
  });
}

export function verifySignedExtensionManifest(
  manifest: SignedExtensionManifest,
  actualContentDigest: string,
  trust: ExtensionTrustStore,
  consent: ExtensionConsent,
  crypto: ManifestCryptoPort
): ManifestVerificationResult {
  const payload = manifestSigningPayload(manifest);
  const manifestDigest = crypto.sha256(payload);
  const rejected = (
    reason: ManifestRejectionReason,
    message: string
  ): ManifestVerificationResult => ({
    kind: "rejected",
    reason,
    message,
    manifestDigest
  });
  if (manifest.content.digest !== actualContentDigest) {
    return rejected(
      "content-digest-mismatch",
      "Extension package content does not match its manifest."
    );
  }
  if (trust.revokedContentDigests.includes(actualContentDigest)) {
    return rejected("content-revoked", "Extension package content has been revoked.");
  }
  if (trust.revokedManifestDigests.includes(manifestDigest)) {
    return rejected("manifest-revoked", "Extension manifest has been revoked.");
  }
  if (trust.revokedKeyIds.includes(manifest.signature.keyId)) {
    return rejected("key-revoked", "Extension signing key has been revoked.");
  }
  const roots = trust.roots.filter((root) => root.keyId === manifest.signature.keyId);
  if (roots.length !== 1) {
    return rejected("key-untrusted", "Extension signing key is not uniquely trusted.");
  }
  const root = roots[0];
  if (
    root === undefined ||
    !crypto.verifyEd25519(payload, manifest.signature.value, root.publicKeyPem)
  ) {
    return rejected("signature-invalid", "Extension manifest signature is invalid.");
  }
  if (consent.kind === "pending") {
    return {
      kind: "consent-required",
      manifest,
      manifestDigest,
      keyId: manifest.signature.keyId
    };
  }
  if (consent.kind === "denied") {
    return rejected("consent-denied", "Extension execution was not approved.");
  }
  if (consent.manifestDigest !== manifestDigest) {
    return rejected("consent-mismatch", "Consent does not match this exact extension manifest.");
  }
  return { kind: "trusted", manifest, manifestDigest };
}
