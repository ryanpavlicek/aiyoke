import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  manifestSigningPayload,
  parseSignedExtensionManifest,
  type SignedExtensionManifest
} from "../../src/extension-sdk/index.js";
import { discoverSignedExtension, extensionId } from "../../src/index.js";
import {
  digestExtensionPackage,
  nodeManifestCrypto
} from "../../src/infrastructure/discovery/index.js";

const roots: string[] = [];
const importMarker = "__aiyokeSignedDiscoveryImports";

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[importMarker];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function signedFixture(options: { readonly manifestVersion?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "aiyoke-signed-extension-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  const descriptor: ExtensionDescriptor & { readonly kind: "pack" } = {
    kind: "pack" as const,
    id: extensionId("signed-fixture"),
    version: "1.0.0",
    apiVersion: EXTENSION_API_VERSION,
    displayName: "Signed fixture",
    description: "A signed external compatibility fixture.",
    capabilities: ["instructions"],
    requires: [],
    conflicts: []
  };
  const moduleSource = `const marker = ${JSON.stringify(importMarker)};
globalThis[marker] = (globalThis[marker] ?? 0) + 1;
const descriptor = ${JSON.stringify(descriptor)};
export const loader = {
  descriptor,
  async load() {
    return {
      descriptor,
      async contribute() {
        return { id: "signed-fixture", title: "Signed fixture", source: "signed-fixture", instructions: [], skills: [], hooks: [], mcpServers: [], subagents: [] };
      }
    };
  }
};
`;
  await writeFile(join(packageRoot, "index.mjs"), moduleSource, "utf8");
  const contentDigest = await digestExtensionPackage(packageRoot);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifestDescriptor = {
    ...descriptor,
    version: options.manifestVersion ?? descriptor.version
  };
  const unsigned: SignedExtensionManifest = {
    schemaVersion: 1,
    extension: manifestDescriptor,
    package: {
      name: "@fixture/signed-pack",
      version: "1.0.0",
      entrypoint: "index.mjs",
      exportName: "loader"
    },
    content: { algorithm: "sha256", digest: contentDigest },
    signature: { algorithm: "ed25519", keyId: "fixture-key", value: "AA==" }
  };
  const payload = manifestSigningPayload(unsigned);
  const manifest: SignedExtensionManifest = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64")
    }
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const trust = {
    roots: [
      {
        keyId: "fixture-key",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
      }
    ],
    revokedKeyIds: [],
    revokedContentDigests: [],
    revokedManifestDigests: []
  };
  return {
    root,
    packageRoot,
    manifestPath,
    manifest,
    trust,
    contentDigest,
    manifestDigest: nodeManifestCrypto.sha256(payload)
  };
}

describe("signed extension discovery", () => {
  it("requires exact consent before importing a trusted Ed25519-signed package", async () => {
    const fixture = await signedFixture();
    const pending = await discoverSignedExtension({
      manifestPath: fixture.manifestPath,
      packageRoot: fixture.packageRoot,
      trust: fixture.trust,
      consent: { kind: "pending" }
    });
    expect(pending).toEqual(
      expect.objectContaining({
        kind: "consent-required",
        manifestDigest: fixture.manifestDigest,
        keyId: "fixture-key"
      })
    );
    expect((globalThis as Record<string, unknown>)[importMarker]).toBeUndefined();

    const loaded = await discoverSignedExtension({
      manifestPath: fixture.manifestPath,
      packageRoot: fixture.packageRoot,
      trust: fixture.trust,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest }
    });
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded") {
      expect(loaded.loader.descriptor).toEqual(fixture.manifest.extension);
      expect(loaded.contentDigest).toBe(fixture.contentDigest);
    }
    expect((globalThis as Record<string, unknown>)[importMarker]).toBe(1);
  });

  it("rejects tampering, revoked trust, and mismatched consent before import", async () => {
    const cases = [
      async () => {
        const fixture = await signedFixture();
        await writeFile(join(fixture.packageRoot, "index.mjs"), "export const loader = {};\n");
        return {
          fixture,
          consent: { kind: "granted" as const, manifestDigest: fixture.manifestDigest }
        };
      },
      async () => {
        const fixture = await signedFixture();
        return {
          fixture: { ...fixture, trust: { ...fixture.trust, revokedKeyIds: ["fixture-key"] } },
          consent: { kind: "granted" as const, manifestDigest: fixture.manifestDigest }
        };
      },
      async () => {
        const fixture = await signedFixture();
        return {
          fixture,
          consent: { kind: "granted" as const, manifestDigest: `sha256:${"0".repeat(64)}` }
        };
      }
    ];
    const reasons: string[] = [];
    for (const create of cases) {
      const { fixture, consent } = await create();
      const result = await discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent
      });
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") reasons.push(result.reason);
    }
    expect(reasons).toEqual(["content-digest-mismatch", "key-revoked", "consent-mismatch"]);
    expect((globalThis as Record<string, unknown>)[importMarker]).toBeUndefined();
  });

  it("fails closed for invalid signatures, untrusted keys, and every revocation level", async () => {
    const cases = [
      async () => {
        const fixture = await signedFixture();
        const manifest = {
          ...fixture.manifest,
          signature: { ...fixture.manifest.signature, value: "AAAA" }
        };
        await writeFile(fixture.manifestPath, JSON.stringify(manifest), "utf8");
        return { fixture, expected: "signature-invalid" };
      },
      async () => {
        const fixture = await signedFixture();
        return {
          fixture: { ...fixture, trust: { ...fixture.trust, roots: [] } },
          expected: "key-untrusted"
        };
      },
      async () => {
        const fixture = await signedFixture();
        return {
          fixture: {
            ...fixture,
            trust: { ...fixture.trust, revokedContentDigests: [fixture.contentDigest] }
          },
          expected: "content-revoked"
        };
      },
      async () => {
        const fixture = await signedFixture();
        return {
          fixture: {
            ...fixture,
            trust: { ...fixture.trust, revokedManifestDigests: [fixture.manifestDigest] }
          },
          expected: "manifest-revoked"
        };
      }
    ];
    for (const create of cases) {
      const { fixture, expected } = await create();
      const result = await discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent: { kind: "pending" }
      });
      expect(result).toEqual(expect.objectContaining({ kind: "rejected", reason: expected }));
    }
    expect((globalThis as Record<string, unknown>)[importMarker]).toBeUndefined();
  });

  it("rejects a module whose exported descriptor differs from its signed descriptor", async () => {
    const fixture = await signedFixture({ manifestVersion: "2.0.0" });
    const result = await discoverSignedExtension({
      manifestPath: fixture.manifestPath,
      packageRoot: fixture.packageRoot,
      trust: fixture.trust,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest }
    });
    expect(result).toEqual(expect.objectContaining({ kind: "rejected", reason: "module-invalid" }));
    expect((globalThis as Record<string, unknown>)[importMarker]).toBe(1);
  });

  it("enforces package byte and file-count bounds before import", async () => {
    const fixture = await signedFixture();
    const results = await Promise.all([
      discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent: { kind: "pending" },
        maxPackageBytes: 1
      }),
      discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent: { kind: "pending" },
        maxPackageFiles: 0
      })
    ]);
    expect(results).toEqual([
      expect.objectContaining({ kind: "rejected", reason: "package-invalid" }),
      expect.objectContaining({ kind: "rejected", reason: "package-invalid" })
    ]);
    expect((globalThis as Record<string, unknown>)[importMarker]).toBeUndefined();
  });

  it("rejects invalid manifests and symlinked package content", async () => {
    const fixture = await signedFixture();
    await writeFile(fixture.manifestPath, "{}", "utf8");
    expect(
      await discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent: { kind: "pending" }
      })
    ).toEqual(expect.objectContaining({ kind: "rejected", reason: "manifest-invalid" }));

    const outside = join(fixture.root, "outside.mjs");
    await writeFile(outside, "export {};\n", "utf8");
    try {
      await symlink(outside, join(fixture.packageRoot, "linked.mjs"), "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
    expect(
      await discoverSignedExtension({
        manifestPath: fixture.manifestPath,
        packageRoot: fixture.packageRoot,
        trust: fixture.trust,
        consent: { kind: "pending" }
      })
    ).toEqual(expect.objectContaining({ kind: "rejected", reason: "package-invalid" }));
  });

  it("bounds and strictly validates manifest input", () => {
    expect(() => parseSignedExtensionManifest("x".repeat(64 * 1024 + 1))).toThrow(/exceeds/);
    expect(() =>
      parseSignedExtensionManifest(
        JSON.stringify({ ...({} as SignedExtensionManifest), schemaVersion: 1, unexpected: true })
      )
    ).toThrow(/not supported/);
    const valid = parseSignedExtensionManifest;
    expect(() =>
      valid(
        JSON.stringify({
          schemaVersion: 1,
          extension: {
            kind: "pack",
            id: "invalid-version",
            version: "latest",
            apiVersion: EXTENSION_API_VERSION,
            displayName: "Invalid version",
            description: "Invalid version fixture.",
            capabilities: [],
            requires: [],
            conflicts: []
          },
          package: {
            name: "invalid-version",
            version: "1.0.0",
            entrypoint: "index.mjs",
            exportName: "loader"
          },
          content: { algorithm: "sha256", digest: `sha256:${"0".repeat(64)}` },
          signature: { algorithm: "ed25519", keyId: "key", value: "AA==" }
        })
      )
    ).toThrow(/extension.version is invalid/);
  });
});
