import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, compareCodePoints, safeRelativePath } from "../../core/index.js";
import {
  type ExtensionLoader,
  type ManifestCryptoPort,
  parseSignedExtensionManifest,
  type SignedExtensionDiscoveryOptions,
  type SignedExtensionDiscoveryResult,
  type SignedExtensionManifest,
  type SignedExtensionPackageVerificationResult,
  verifySignedExtensionManifest
} from "../../extension-sdk/index.js";

const DEFAULT_MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PACKAGE_FILES = 2_000;

function diagnostic(options: SignedExtensionDiscoveryOptions, stage: string, reason: string): void {
  try {
    options.diagnostics?.emit({ boundary: "discovery", stage, reason });
  } catch {
    // Diagnostics are opt-in and never alter trust decisions.
  }
}

interface PackageEntry {
  readonly path: string;
  readonly content: Uint8Array;
}

interface PackageSnapshot {
  readonly root: string;
  readonly entries: readonly PackageEntry[];
}

class NodeManifestCrypto implements ManifestCryptoPort {
  sha256(value: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }

  verifyEd25519(payload: string, signatureBase64: string, publicKeyPem: string): boolean {
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") return false;
      return verify(
        null,
        Buffer.from(payload, "utf8"),
        key,
        Buffer.from(signatureBase64, "base64")
      );
    } catch {
      return false;
    }
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function packageEntries(
  packageRoot: string,
  maxBytes: number,
  maxFiles: number
): Promise<PackageSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxPackageBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new TypeError("maxPackageFiles must be a positive safe integer.");
  }
  const requestedRoot = resolve(packageRoot);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new TypeError("Extension package root must be a real directory.");
  }
  const root = await realpath(requestedRoot);
  const entries: PackageEntry[] = [];
  let bytes = 0;
  let directories = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCodePoints(left.name, right.name)
    );
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      if (!inside(root, absolute)) throw new TypeError("Extension package path escaped its root.");
      const path = relative(root, absolute).replaceAll(sep, "/");
      if (child.isSymbolicLink())
        throw new TypeError(`Extension package contains a symlink: ${path}`);
      if (child.isDirectory()) {
        directories += 1;
        if (directories > maxFiles) {
          throw new RangeError("Extension package has too many directories.");
        }
        await visit(absolute);
        continue;
      }
      if (!child.isFile())
        throw new TypeError(`Extension package contains a non-regular file: ${path}`);
      const content = await readFile(absolute);
      entries.push({ path: safeRelativePath(path), content });
      bytes += content.byteLength;
      if (entries.length > maxFiles) throw new RangeError("Extension package has too many files.");
      if (bytes > maxBytes) throw new RangeError("Extension package exceeds its byte limit.");
    }
  };
  await visit(root);
  return { root, entries: entries.sort((left, right) => compareCodePoints(left.path, right.path)) };
}

function contentDigest(entries: readonly PackageEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path, "utf8");
    hash.update("\0");
    hash.update(String(entry.content.byteLength), "utf8");
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function isLoader(value: unknown): value is ExtensionLoader {
  if (value === null || typeof value !== "object") return false;
  const loader = value as Partial<ExtensionLoader>;
  return loader.descriptor !== undefined && typeof loader.load === "function";
}

export async function verifySignedExtensionPackage(
  options: SignedExtensionDiscoveryOptions
): Promise<SignedExtensionPackageVerificationResult> {
  let manifest: SignedExtensionManifest;
  try {
    manifest = parseSignedExtensionManifest(await readFile(resolve(options.manifestPath), "utf8"));
  } catch {
    diagnostic(options, "manifest-read", "manifest-invalid");
    return {
      kind: "rejected",
      reason: "manifest-invalid",
      message: "Extension manifest is invalid."
    };
  }

  let firstPackage: PackageSnapshot;
  try {
    firstPackage = await packageEntries(
      options.packageRoot,
      options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES,
      options.maxPackageFiles ?? DEFAULT_MAX_PACKAGE_FILES
    );
  } catch {
    diagnostic(options, "package-snapshot", "package-invalid");
    return {
      kind: "rejected",
      reason: "package-invalid",
      message: "Extension package is invalid."
    };
  }
  const actualDigest = contentDigest(firstPackage.entries);
  const verification = verifySignedExtensionManifest(
    manifest,
    actualDigest,
    options.trust,
    options.consent,
    new NodeManifestCrypto()
  );
  if (verification.kind !== "trusted") {
    if (verification.kind === "rejected") {
      diagnostic(options, "manifest-verification", verification.reason);
    }
    return verification;
  }

  try {
    const secondPackage = await packageEntries(
      firstPackage.root,
      options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES,
      options.maxPackageFiles ?? DEFAULT_MAX_PACKAGE_FILES
    );
    if (contentDigest(secondPackage.entries) !== actualDigest) {
      diagnostic(options, "package-resnapshot", "package-changed");
      return {
        kind: "rejected",
        reason: "package-invalid",
        message: "Extension package changed during verification.",
        manifestDigest: verification.manifestDigest
      };
    }
    const entrypoint = resolve(
      secondPackage.root,
      ...safeRelativePath(manifest.package.entrypoint).split("/")
    );
    if (!inside(secondPackage.root, entrypoint))
      throw new TypeError("Entrypoint escaped package root.");
    const entrypointMetadata = await lstat(entrypoint);
    if (entrypointMetadata.isSymbolicLink() || !entrypointMetadata.isFile()) {
      throw new TypeError("Entrypoint must be a regular file.");
    }
    const entrypointRealPath = await realpath(entrypoint);
    if (!inside(secondPackage.root, entrypointRealPath))
      throw new TypeError("Entrypoint escaped package root.");
    return {
      kind: "verified",
      manifest,
      manifestDigest: verification.manifestDigest,
      contentDigest: actualDigest,
      packageRoot: secondPackage.root,
      entrypointPath: entrypointRealPath
    };
  } catch {
    diagnostic(options, "entrypoint-validation", "package-invalid");
    return {
      kind: "rejected",
      reason: "package-invalid",
      message: "Verified extension package is invalid.",
      manifestDigest: verification.manifestDigest
    };
  }
}

export async function discoverSignedExtension(
  options: SignedExtensionDiscoveryOptions
): Promise<SignedExtensionDiscoveryResult> {
  const verification = await verifySignedExtensionPackage(options);
  if (verification.kind !== "verified") return verification;
  try {
    const url = pathToFileURL(verification.entrypointPath);
    url.searchParams.set("aiyoke-content", verification.contentDigest);
    const loaded = (await import(url.href)) as Readonly<Record<string, unknown>>;
    const loader = loaded[verification.manifest.package.exportName];
    if (
      !isLoader(loader) ||
      canonicalJson(loader.descriptor) !== canonicalJson(verification.manifest.extension)
    ) {
      throw new TypeError("Module export does not match the signed extension descriptor.");
    }
    return {
      kind: "loaded",
      loader,
      manifest: verification.manifest,
      manifestDigest: verification.manifestDigest,
      contentDigest: verification.contentDigest
    };
  } catch {
    diagnostic(options, "module-import", "module-invalid");
    return {
      kind: "rejected",
      reason: "module-invalid",
      message: "Verified extension module could not be loaded.",
      manifestDigest: verification.manifestDigest
    };
  }
}

export async function digestExtensionPackage(
  packageRoot: string,
  options: { readonly maxBytes?: number; readonly maxFiles?: number } = {}
): Promise<string> {
  const result = await packageEntries(
    packageRoot,
    options.maxBytes ?? DEFAULT_MAX_PACKAGE_BYTES,
    options.maxFiles ?? DEFAULT_MAX_PACKAGE_FILES
  );
  return contentDigest(result.entries);
}

export const nodeManifestCrypto: ManifestCryptoPort = new NodeManifestCrypto();
