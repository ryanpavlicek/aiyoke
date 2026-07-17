import { describe, expect, it } from "vitest";
import { type ArtifactIntent, extensionId, type HarnessSpec } from "../../src/core/index.js";
import {
  defineLanguage,
  defineTarget,
  EXTENSION_API_VERSION,
  type ExtensionLoader,
  runExtensionCompatibility,
  type TargetExtension
} from "../../src/extension-sdk/index.js";
import { defaultHarnessSpec } from "../../src/infrastructure/config/index.js";

const targetId = extensionId("compat-target");

function targetLoader(
  render: TargetExtension["render"],
  overrides: Partial<TargetExtension["descriptor"]> = {}
): ExtensionLoader<TargetExtension> {
  const extension = defineTarget({
    descriptor: {
      kind: "target" as const,
      id: targetId,
      version: "1.0.0",
      apiVersion: EXTENSION_API_VERSION,
      displayName: "Compatibility target",
      description: "A compatibility fixture target.",
      capabilities: ["instructions"],
      requires: [],
      conflicts: [],
      ...overrides
    },
    surface: "coding-agent" as const,
    render,
    async verify() {
      return [];
    }
  });
  return {
    descriptor: extension.descriptor,
    async load() {
      return extension;
    }
  };
}

function fixture(spec: HarnessSpec = defaultHarnessSpec("compatibility")) {
  return {
    spec,
    files: { "package.json": "{}" },
    target: {
      kind: "coding-agent" as const,
      adapter: targetId,
      features: ["instructions" as const],
      settings: {}
    },
    secretCanaries: ["secret-canary"]
  };
}

describe("extension compatibility kit", () => {
  it("proves descriptor, graph, identity, repeatability, paths, and secret safety", async () => {
    const loader = targetLoader(async () => [
      {
        path: "generated/instructions.md",
        content: "# Stable\n",
        source: "compat-target",
        executable: false,
        ownership: "generated"
      }
    ]);
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report).toEqual({
      kind: "passed",
      extension: "target:compat-target",
      checks: [
        { id: "descriptor", status: "passed" },
        { id: "dependencies", status: "passed" },
        { id: "loader-identity", status: "passed" },
        { id: "execution", status: "passed" },
        { id: "determinism", status: "passed" },
        { id: "artifact-safety", status: "passed" },
        { id: "secret-safety", status: "passed" }
      ],
      findings: []
    });
  });

  it("reports nondeterminism, unsafe paths, oversized output, and secret canaries", async () => {
    let call = 0;
    const loader = targetLoader(async () => {
      call += 1;
      return [
        {
          path: "../escape.md",
          content: `secret-canary-${call}\r\n${"x".repeat(64)}`,
          source: "compat-target",
          executable: false,
          ownership: "generated"
        }
      ];
    });
    const report = await runExtensionCompatibility({
      loader,
      fixture: { ...fixture(), maxOutputBytes: 32 }
    });
    expect(report.kind).toBe("failed");
    if (report.kind === "failed") {
      expect(report.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining([
          "EXTENSION_EXECUTION_FAILED",
          "UNSAFE_EXTENSION_OUTPUT",
          "NONDETERMINISTIC_OUTPUT",
          "SECRET_CANARY_LEAKED"
        ])
      );
      expect(JSON.stringify(report)).not.toContain("secret-canary");
    }
  });

  it("contains loader failures and redacts secret-bearing exceptions", async () => {
    const base = targetLoader(async () => []);
    const loader: ExtensionLoader = {
      descriptor: base.descriptor,
      async load() {
        throw new Error("loader rejected secret-canary");
      }
    };
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("secret-canary");
    expect(JSON.stringify(report)).toContain("[REDACTED]");
  });

  it("rejects missing dependency graphs before extension execution", async () => {
    const loader = targetLoader(async () => [], {
      requires: [{ kind: "language", id: extensionId("missing-language") }]
    });
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report.kind).toBe("failed");
    if (report.kind === "failed") {
      expect(report.findings[0]).toEqual(
        expect.objectContaining({ check: "dependencies", code: "DEPENDENCY_GRAPH_INVALID" })
      );
    }
  });

  it("rejects incompatible API versions through the public registry boundary", async () => {
    const compatible = targetLoader(async () => []);
    const loader = {
      ...compatible,
      descriptor: { ...compatible.descriptor, apiVersion: "99.0.0" }
    } as unknown as ExtensionLoader;
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).toContain("expected 1.0.0");
  });

  it("requires complete descriptor identity from a lazy loader", async () => {
    const declared = targetLoader(async () => []);
    const changed = targetLoader(async () => [], { description: "Changed after registration." });
    const loader: ExtensionLoader = {
      descriptor: declared.descriptor,
      async load() {
        return changed.load();
      }
    };
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report.kind).toBe("failed");
    if (report.kind === "failed") {
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          check: "loader-identity",
          code: "LOADER_IDENTITY_INVALID"
        })
      );
    }
  });

  it("rejects duplicate normalized artifact ownership", async () => {
    const artifact = {
      path: "same/path.md",
      content: "stable\n",
      source: "compat-target",
      executable: false,
      ownership: "generated" as const
    };
    const loader = targetLoader(async () => [artifact, artifact]);
    const report = await runExtensionCompatibility({ loader, fixture: fixture() });
    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).toContain("duplicated");
  });

  it.each([
    ["non-boolean executable", { executable: "yes" }],
    ["unknown ownership", { ownership: "borrowed" }],
    ["blank source", { source: "  " }],
    ["unsupported fields", { unexpected: true }],
    [
      "multiline managed markers",
      { ownership: "managed-section", markers: { start: "start\ncontinued", end: "end" } }
    ]
  ])("fails closed for artifacts with %s", async (_label, overrides) => {
    const candidate = {
      path: "generated/result.md",
      content: "stable\n",
      source: "compat-target",
      executable: false,
      ownership: "generated",
      ...overrides
    } as unknown as ArtifactIntent;
    const report = await runExtensionCompatibility({
      loader: targetLoader(async () => [candidate]),
      fixture: fixture()
    });

    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).toContain("UNSAFE_EXTENSION_OUTPUT");
  });

  it("returns a structured failure for cyclic hostile output", async () => {
    const candidate: Record<string, unknown> = {
      path: "generated/result.md",
      content: "stable\n",
      source: "compat-target",
      executable: false,
      ownership: "generated"
    };
    candidate.self = candidate;
    const report = await runExtensionCompatibility({
      loader: targetLoader(async () => [candidate as unknown as ArtifactIntent]),
      fixture: fixture()
    });

    expect(report.kind).toBe("failed");
    if (report.kind === "failed") {
      expect(report.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining([
          "UNSAFE_EXTENSION_OUTPUT",
          "DETERMINISM_NOT_TESTED",
          "SECRET_SAFETY_NOT_TESTED"
        ])
      );
    }
  });

  it("rejects noncanonical fixture workspace paths", async () => {
    const report = await runExtensionCompatibility({
      loader: targetLoader(async () => []),
      fixture: { ...fixture(), files: { "nested\\package.json": "{}" } }
    });

    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).toContain("Fixture path must already be normalized");
  });

  it("validates detector confidence and contributed module shape", async () => {
    const language = defineLanguage({
      descriptor: {
        kind: "language" as const,
        id: extensionId("bad-language"),
        version: "1.0.0",
        apiVersion: EXTENSION_API_VERSION,
        displayName: "Bad language",
        description: "Returns invalid compatibility data.",
        capabilities: ["detection"],
        requires: [],
        conflicts: []
      },
      async detect() {
        return { confidence: 2, reasons: ["invalid"] };
      },
      async contribute() {
        return {
          id: "",
          title: "",
          source: "",
          instructions: [],
          skills: [],
          hooks: [],
          mcpServers: [],
          subagents: []
        };
      }
    });
    const loader = {
      descriptor: language.descriptor,
      async load() {
        return language;
      }
    };
    const report = await runExtensionCompatibility({ loader, fixture: { spec: fixture().spec } });
    expect(report.kind).toBe("failed");
    expect(JSON.stringify(report)).toContain("confidence in [0, 1]");
  });
});
