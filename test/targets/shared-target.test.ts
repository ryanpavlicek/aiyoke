import { describe, expect, it } from "vitest";
import { extensionId, type HarnessSpec, type TargetSpec } from "../../src/core/index.js";
import type { TargetExtension, TargetVerificationContext } from "../../src/extension-sdk/index.js";
import {
  descriptor,
  loaderFor,
  verifyArtifacts,
  verifyTarget
} from "../../src/extensions/shared/target.js";

const spec: HarnessSpec = {
  schemaVersion: 3,
  project: { name: "shared-target", architecture: "layered" },
  composition: { kind: "single", stack: { languages: [], frameworks: [] } },
  runtime: { kind: "disabled" },
  targets: [],
  packs: [],
  generation: { sourceDirectory: ".aiyoke", lockFile: ".aiyoke/lock.json", lineEndings: "lf" }
};

function context(target: TargetSpec): TargetVerificationContext {
  return {
    spec,
    target,
    workspace: {
      root: ".",
      files: [],
      read: async () => undefined,
      exists: async (path) => path === "present.md"
    }
  };
}

describe("shared target helpers", () => {
  it("builds sorted descriptors and preserves loader identity", async () => {
    const targetDescriptor = descriptor("fixture", "Fixture", "Fixture target.", [
      "\u{10000}",
      "\uE000",
      "alpha"
    ]);
    const implementation: TargetExtension = {
      descriptor: targetDescriptor,
      surface: "coding-agent",
      render: async () => [],
      verify: async () => []
    };
    const loader = loaderFor(implementation);

    expect(targetDescriptor.capabilities).toEqual(["alpha", "\uE000", "\u{10000}"]);
    expect(loader.descriptor).toBe(targetDescriptor);
    expect(await loader.load()).toBe(implementation);
  });

  it("reports adapter and surface mismatches before artifact checks", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("actual"),
      features: [],
      settings: {}
    } as const;
    expect(verifyTarget(context(target), "expected", "coding-agent")).toEqual([
      expect.objectContaining({ code: "TARGET_ADAPTER_MISMATCH" })
    ]);
    expect(
      verifyTarget(context(target), "actual", "chat-plugin").map((finding) => finding.code)
    ).toEqual(["TARGET_KIND_MISMATCH"]);
    expect(
      await verifyArtifacts(context(target), "expected", "coding-agent", ["missing.md"])
    ).toEqual([expect.objectContaining({ code: "TARGET_ADAPTER_MISMATCH" })]);
  });

  it("reports missing artifacts in Unicode code-point order", async () => {
    const target = {
      kind: "coding-agent",
      adapter: extensionId("fixture"),
      features: [],
      settings: {}
    } as const;
    const findings = await verifyArtifacts(context(target), "fixture", "coding-agent", [
      "\u{10000}.md",
      "present.md",
      "\uE000.md"
    ]);

    expect(findings.map((finding) => finding.path)).toEqual(["\uE000.md", "\u{10000}.md"]);
  });
});
