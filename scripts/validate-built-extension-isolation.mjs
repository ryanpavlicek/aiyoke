#!/usr/bin/env node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSigningPayload } from "../dist/extension-sdk/index.js";
import { renderSignedExtensionIsolated } from "../dist/index.js";
import {
  digestExtensionPackage,
  nodeManifestCrypto
} from "../dist/infrastructure/discovery/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = path.join(root, "examples", "extensions", "hello-target");
const packageRoot = path.join(exampleRoot, "package");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "aiyoke-built-isolation-"));

try {
  const template = JSON.parse(
    await readFile(path.join(exampleRoot, "aiyoke-extension.template.json"), "utf8")
  );
  const contentDigest = await digestExtensionPackage(packageRoot);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    ...template,
    content: { algorithm: "sha256", digest: contentDigest },
    signature: { algorithm: "ed25519", keyId: "built-smoke-key", value: "AA==" }
  };
  const payload = manifestSigningPayload(unsigned);
  const manifest = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64")
    }
  };
  const manifestPath = path.join(temporaryRoot, "aiyoke-extension.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const result = await renderSignedExtensionIsolated({
    manifestPath,
    packageRoot,
    trust: {
      roots: [
        {
          keyId: "built-smoke-key",
          publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
        }
      ],
      revokedKeyIds: [],
      revokedContentDigests: [],
      revokedManifestDigests: []
    },
    consent: {
      kind: "granted",
      manifestDigest: nodeManifestCrypto.sha256(payload)
    },
    invocation: {
      kind: "target-render",
      context: {
        spec: {
          schemaVersion: 3,
          project: { name: "built-smoke", architecture: "layered" },
          composition: { kind: "single", stack: { languages: [], frameworks: [] } },
          runtime: { kind: "disabled" },
          targets: [],
          packs: [],
          generation: {
            sourceDirectory: ".aiyoke",
            lockFile: ".aiyoke/lock.json",
            lineEndings: "lf"
          }
        },
        target: {
          kind: "coding-agent",
          adapter: "hello-target",
          features: ["instructions"],
          settings: {}
        },
        modules: [],
        workspace: {
          root: ".",
          files: [],
          async read() {
            return undefined;
          },
          async exists() {
            return false;
          }
        }
      }
    }
  });
  if (
    result.kind !== "rendered" ||
    result.artifacts.length !== 1 ||
    result.artifacts[0]?.path !== ".hello/AIYOKE.md"
  ) {
    throw new Error("Compiled renderer isolation smoke failed.");
  }
  console.log("Compiled renderer isolation smoke passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
