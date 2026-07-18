import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionId, type HarnessSpec } from "../../src/core/index.js";
import {
  EXTENSION_API_VERSION,
  type ExtensionDescriptor,
  manifestSigningPayload,
  type SignedExtensionManifest
} from "../../src/extension-sdk/index.js";
import { renderSignedExtensionIsolated } from "../../src/index.js";
import { digestExtensionPackage } from "../../src/infrastructure/discovery/index.js";
import { nodeManifestCrypto } from "../../src/infrastructure/discovery/node-signed-discovery.js";

const roots: string[] = [];
const secretName = "AIYOKE_ISOLATION_TEST_SECRET";
const originalSecret = process.env[secretName];

afterEach(async () => {
  if (originalSecret === undefined) delete process.env[secretName];
  else process.env[secretName] = originalSecret;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const spec: HarnessSpec = {
  schemaVersion: 3,
  project: { name: "isolated-renderer", architecture: "layered" },
  composition: { kind: "single", stack: { languages: [], frameworks: [] } },
  runtime: { kind: "disabled" },
  targets: [],
  packs: [],
  generation: { sourceDirectory: ".aiyoke", lockFile: ".aiyoke/lock.json", lineEndings: "lf" }
};

const descriptor: ExtensionDescriptor & { readonly kind: "target" } = {
  kind: "target" as const,
  id: extensionId("isolated-target"),
  version: "1.0.0",
  apiVersion: EXTENSION_API_VERSION,
  displayName: "Isolated target",
  description: "An isolated renderer fixture.",
  capabilities: ["instructions"],
  requires: [],
  conflicts: []
};

function invocation() {
  return {
    kind: "target-render" as const,
    context: {
      spec,
      target: {
        kind: "coding-agent" as const,
        adapter: descriptor.id,
        features: ["instructions" as const],
        settings: {}
      },
      modules: [],
      workspace: {
        root: "C:/fixture",
        files: ["package.json"],
        async read(path: string) {
          return path === "package.json" ? "{}" : undefined;
        },
        async exists(path: string) {
          return path === "package.json";
        }
      }
    }
  };
}

async function signedRenderer(renderBody: string) {
  const root = await mkdtemp(join(tmpdir(), "aiyoke-isolated-renderer-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  const source = `const descriptor = ${JSON.stringify(descriptor)};
export const loader = {
  descriptor,
  async load() {
    return {
      descriptor,
      surface: "coding-agent",
      async render(context) {
        ${renderBody}
      },
      async verify() { return []; }
    };
  }
};
`;
  await writeFile(join(packageRoot, "index.mjs"), source, "utf8");
  const contentDigest = await digestExtensionPackage(packageRoot);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const unsigned: SignedExtensionManifest = {
    schemaVersion: 1,
    extension: descriptor,
    package: {
      name: "@fixture/isolated-target",
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
  return {
    manifestPath,
    packageRoot,
    trust: {
      roots: [
        {
          keyId: "fixture-key",
          publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
        }
      ],
      revokedKeyIds: [],
      revokedContentDigests: [],
      revokedManifestDigests: []
    },
    manifestDigest: nodeManifestCrypto.sha256(payload)
  };
}

async function render(renderBody: string, overrides: Record<string, unknown> = {}) {
  const fixture = await signedRenderer(renderBody);
  return renderSignedExtensionIsolated({
    ...fixture,
    consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
    invocation: invocation(),
    ...overrides
  });
}

describe("isolated signed renderers", () => {
  it("renders through the versioned child protocol without inheriting host secrets", async () => {
    process.env[secretName] = "must-not-cross-process-boundary";
    const result = await render(
      `
      console.log("renderer stdout is not the protocol");
      const workspace = await context.workspace.read("package.json");
      const heapLimit = process.execArgv.find((value) => value.startsWith("--max-old-space-size="));
      return [{
        path: "generated/result.md",
        content: JSON.stringify({ workspace, secret: process.env.${secretName} ?? "absent", heapLimit }),
        source: "isolated-target",
        executable: false,
        ownership: "generated"
      }];
    `,
      { limits: { memoryMb: 64 } }
    );
    expect(result.kind).toBe("rendered");
    if (result.kind === "rendered") {
      expect(result.artifacts).toEqual([
        {
          path: "generated/result.md",
          content: JSON.stringify({
            workspace: "{}",
            secret: "absent",
            heapLimit: "--max-old-space-size=64"
          }),
          source: "isolated-target",
          executable: false,
          ownership: "generated"
        }
      ]);
    }
  }, 15_000);

  it("kills a renderer that exceeds its deadline", async () => {
    const result = await render("await new Promise(() => {});", {
      limits: { timeoutMs: 1_000 }
    });
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-timeout" })
    );
  }, 15_000);

  it("escalates termination when a renderer ignores SIGTERM", async () => {
    const markerName = "survived-after-timeout.txt";
    const fixture = await signedRenderer(`
      process.on("SIGTERM", () => {});
      setTimeout(async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(${JSON.stringify(markerName)}, "survived", "utf8");
      }, 1500);
      await new Promise(() => {});
    `);
    const marker = join(fixture.packageRoot, markerName);
    const result = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: invocation(),
      limits: { timeoutMs: 250 }
    });
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-timeout" })
    );
    await new Promise((resolve) => setTimeout(resolve, 1_750));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("cancels an active renderer", async () => {
    const fixture = await signedRenderer("await new Promise(() => {});");
    const controller = new AbortController();
    const pending = renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: invocation(),
      limits: { timeoutMs: 5_000 },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 500);
    expect(await pending).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-cancelled" })
    );
  }, 15_000);

  it("rejects oversized and structurally hostile artifact output", async () => {
    const oversized = await render(
      `return [{ path: "large.md", content: "x".repeat(4096), source: "isolated-target", executable: false, ownership: "generated" }];`,
      { limits: { maxOutputBytes: 512 } }
    );
    const unsafe = await render(
      `return [{ path: "../escape.md", content: "bad", source: "isolated-target", executable: false, ownership: "generated" }];`
    );
    expect(oversized).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-output-limit" })
    );
    expect(unsafe).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-failed" })
    );
  }, 20_000);

  it("emits opt-in sanitized renderer stage diagnostics", async () => {
    const events: Array<{ boundary: string; stage: string; reason: string }> = [];
    const result = await render(
      `return [{ path: "../escape.md", content: "secret detail", source: "isolated-target", executable: false, ownership: "generated" }];`,
      { diagnostics: { emit: (event: (typeof events)[number]) => void events.push(event) } }
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-failed" })
    );
    expect(events).toEqual([
      { boundary: "isolation", stage: "renderer", reason: "artifacts-failed" }
    ]);
    expect(JSON.stringify(events)).not.toContain("secret detail");
  });

  it.each([
    ".git/hooks/pre-commit",
    "aiyoke.yaml",
    ".aiyoke/backups/recovery.yaml",
    ".aiyoke/lock.json"
  ])("rejects isolated output to reserved destination %s", async (path) => {
    const result = await render(
      `return [{ path: ${JSON.stringify(path)}, content: "bad", source: "isolated-target", executable: true, ownership: "generated" }];`
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-failed" })
    );
  });

  it("filters environment secrets and nested dependencies from renderer snapshots", async () => {
    const fixture = await signedRenderer(`
      const paths = context.workspace.files;
      const reads = Object.fromEntries(await Promise.all(
        [".env", ".env.local", ".env.example", "packages/app/node_modules/pkg/index.js", "package.json"]
          .map(async (path) => [path, await context.workspace.read(path)])
      ));
      return [{
        path: "generated/snapshot.json",
        content: JSON.stringify({ paths, reads }),
        source: "isolated-target",
        executable: false,
        ownership: "generated"
      }];
    `);
    const base = invocation();
    const values: Readonly<Record<string, string>> = {
      ".env": "SECRET=one",
      ".env.local": "SECRET=two",
      ".env.example": "SECRET=replace-me",
      "packages/app/node_modules/pkg/index.js": "dependency",
      "package.json": "{}"
    };
    const result = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: {
        ...base,
        context: {
          ...base.context,
          workspace: {
            root: "C:/fixture",
            files: Object.keys(values),
            async read(path: string) {
              return values[path];
            },
            async exists(path: string) {
              return values[path] !== undefined;
            }
          }
        }
      },
      limits: { maxWorkspaceFiles: 2 }
    });
    expect(result.kind).toBe("rendered");
    if (result.kind === "rendered") {
      const payload = JSON.parse(result.artifacts[0]?.content ?? "null") as {
        readonly paths: readonly string[];
        readonly reads: Readonly<Record<string, string | undefined>>;
      };
      expect(payload.paths).toEqual([".env.example", "package.json"]);
      expect(payload.reads).toEqual({
        ".env.example": "SECRET=replace-me",
        "package.json": "{}"
      });
    }
  }, 15_000);

  it("rejects bounded input before spawning a renderer", async () => {
    const result = await render(
      `return [{ path: "unused.md", content: "unused", source: "isolated-target", executable: false, ownership: "generated" }];`,
      { limits: { maxInputBytes: 16 } }
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-input-limit" })
    );
  });

  it("short-circuits pending consent, invalid limits, and renderer-kind mismatch", async () => {
    const fixture = await signedRenderer(
      `return [{ path: "unused.md", content: "unused", source: "isolated-target", executable: false, ownership: "generated" }];`
    );
    const pending = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "pending" },
      invocation: invocation()
    });
    const invalidLimits = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "pending" },
      invocation: invocation(),
      limits: { memoryMb: 1 }
    });
    const runtime = {
      kind: "enabled" as const,
      outputDirectory: "runtime",
      profile: { kind: "production" as const }
    };
    const mismatch = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: {
        kind: "runtime-render",
        context: {
          spec: { ...spec, runtime },
          runtime,
          scope: { kind: "project", stack: { languages: [], frameworks: [] } },
          workspace: invocation().context.workspace
        }
      }
    });
    expect(pending.kind).toBe("consent-required");
    expect(invalidLimits).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-input-limit" })
    );
    expect(mismatch).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "renderer-kind-mismatch" })
    );
  });

  it("rejects duplicate workspace snapshots and honors an already-aborted signal", async () => {
    const fixture = await signedRenderer(
      `return [{ path: "unused.md", content: "unused", source: "isolated-target", executable: false, ownership: "generated" }];`
    );
    const base = invocation();
    const duplicate = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: {
        ...base,
        context: {
          ...base.context,
          workspace: { ...base.context.workspace, files: ["package.json", "package.json"] }
        }
      }
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: base,
      signal: controller.signal
    });
    expect(duplicate).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-input-limit" })
    );
    expect(cancelled).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-cancelled" })
    );
  });

  it("accepts bounded managed sections and contains excess artifact counts", async () => {
    const managed = await render(`return [{
      path: "managed.md",
      content: "managed",
      source: "isolated-target",
      executable: false,
      ownership: "managed-section",
      markers: { start: "<!-- start -->", end: "<!-- end -->" }
    }];`);
    const excess = await render(
      `return [
        { path: "one.md", content: "one", source: "isolated-target", executable: false, ownership: "generated" },
        { path: "two.md", content: "two", source: "isolated-target", executable: false, ownership: "generated" }
      ];`,
      { limits: { maxArtifacts: 1 } }
    );
    expect(managed.kind).toBe("rendered");
    expect(excess).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-failed" })
    );
  }, 15_000);

  it("contains renderer exceptions and malformed artifact variants", async () => {
    const bodies = [
      `throw new Error("renderer failure");`,
      `return null;`,
      `return [
        { path: "same/file.md", content: "one", source: "isolated-target", executable: false, ownership: "generated" },
        { path: "same\\\\file.md", content: "two", source: "isolated-target", executable: false, ownership: "generated" }
      ];`,
      `return [{ path: "extra.md", content: "bad", source: "isolated-target", executable: false, ownership: "generated", unexpected: true }];`,
      `return [{
        path: "managed.md",
        content: "managed",
        source: "isolated-target",
        executable: false,
        ownership: "managed-section",
        markers: { start: "start\\ncontinued", end: "end" }
      }];`
    ];

    for (const body of bodies) {
      expect(await render(body)).toEqual(
        expect.objectContaining({ kind: "rejected", reason: "isolation-failed" })
      );
    }
  }, 30_000);

  it("rejects inconsistent and over-count workspace snapshots before spawning", async () => {
    const fixture = await signedRenderer(`return [];`);
    const base = invocation();
    const inconsistent = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: {
        ...base,
        context: {
          ...base.context,
          workspace: { ...base.context.workspace, read: async () => undefined }
        }
      }
    });
    const overCount = await renderSignedExtensionIsolated({
      ...fixture,
      consent: { kind: "granted", manifestDigest: fixture.manifestDigest },
      invocation: {
        ...base,
        context: {
          ...base.context,
          workspace: { ...base.context.workspace, files: ["one", "two"] }
        }
      },
      limits: { maxWorkspaceFiles: 1 }
    });

    expect(inconsistent).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-input-limit" })
    );
    expect(overCount).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-input-limit" })
    );
  });

  it("contains excessive child diagnostics as a protocol violation", async () => {
    const result = await render(`
      console.error("x".repeat(70 * 1024));
      await new Promise(() => {});
    `);
    expect(result).toEqual(
      expect.objectContaining({ kind: "rejected", reason: "isolation-protocol" })
    );
  }, 15_000);
});
