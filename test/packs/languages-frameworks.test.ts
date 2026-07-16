import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "../../src/core/index.js";
import type { WorkspaceSnapshot } from "../../src/extension-sdk/index.js";
import {
  actix,
  axum,
  chi,
  django,
  fastapi,
  fastify,
  fiber,
  flask,
  gin,
  nestjs,
  nextjs
} from "../../src/extensions/frameworks/index.js";
import { go, javascript, python, rust, typescript } from "../../src/extensions/languages/index.js";

function workspace(
  contents: Record<string, string>,
  files = Object.keys(contents)
): WorkspaceSnapshot {
  return {
    root: "/workspace",
    files,
    read: async (path) => contents[path],
    exists: async (path) => path in contents
  };
}

const spec = {} as HarnessSpec;

describe("first-party language extensions", () => {
  it("detects Python from deterministic project markers and contributes guidance", async () => {
    const extension = python;
    const detection = await extension.detect(
      workspace({ "pyproject.toml": "[project]\nname='demo'", "src/demo.py": "def run(): ..." })
    );
    expect(detection.confidence).toBeGreaterThan(0.9);
    expect(detection.reasons).toEqual(["found pyproject.toml", "found 1 Python source file"]);
    const module = await extension.contribute({ spec, workspace: workspace({}) });
    expect(module.instructions.length).toBeGreaterThanOrEqual(2);
    expect(module.skills[0]?.name).toBe("python-review");
  });

  it("detects TypeScript and JavaScript using distinct source markers", async () => {
    const ts = await typescript.detect(
      workspace({ "tsconfig.json": "{}", "src/index.ts": "export {}" })
    );
    expect(ts.confidence).toBe(0.95);
    expect(ts.reasons).toEqual(["found tsconfig.json", "found 1 TypeScript source file"]);

    const js = await javascript.detect(workspace({ "src/index.js": "console.log('ok')" }));
    expect(js.confidence).toBe(0.65);
    expect(js.reasons).toEqual(["found 1 JavaScript source file"]);
  });

  it("detects Rust and Go from module files", async () => {
    await expect(
      rust.detect(workspace({ "Cargo.toml": "[package]", "src/lib.rs": "pub fn ok() {}" }))
    ).resolves.toMatchObject({
      confidence: 0.95,
      reasons: ["found cargo.toml", "found 1 Rust source file"]
    });
    await expect(
      go.detect(workspace({ "go.mod": "module example", "main.go": "package main" }))
    ).resolves.toMatchObject({
      confidence: 0.95,
      reasons: ["found go.mod", "found 1 Go source file"]
    });
  });
});

describe("first-party framework extensions", () => {
  it("finds a Python dependency even when another marker sorts first", async () => {
    const detection = await fastapi.detect(
      workspace({
        "pyproject.toml": "[build-system]",
        "requirements.txt": "fastapi==0.115.0"
      })
    );
    expect(detection).toEqual({
      confidence: 0.99,
      reasons: ["requirements.txt references fastapi"]
    });
    expect(fastapi.descriptor.requires).toEqual([{ kind: "language", id: "python" }]);
    await expect(
      fastapi.detect(workspace({ "pyproject.toml": "[project]\nname='plain'" }))
    ).resolves.toEqual({
      confidence: 0,
      reasons: []
    });
  });

  it("declares language requirements for single-language frameworks", () => {
    expect(django.descriptor.requires).toEqual([{ kind: "language", id: "python" }]);
    expect(flask.descriptor.requires).toEqual([{ kind: "language", id: "python" }]);
    expect(axum.descriptor.requires).toEqual([{ kind: "language", id: "rust" }]);
    expect(actix.descriptor.requires).toEqual([{ kind: "language", id: "rust" }]);
    expect(chi.descriptor.requires).toEqual([{ kind: "language", id: "go" }]);
    expect(gin.descriptor.requires).toEqual([{ kind: "language", id: "go" }]);
    expect(fiber.descriptor.requires).toEqual([{ kind: "language", id: "go" }]);
    expect(nestjs.descriptor.requires).toEqual([{ kind: "language", id: "typescript" }]);
  });

  it("supports JavaScript and TypeScript framework packages with useful modules", async () => {
    const nextDetection = await nextjs.detect(
      workspace({
        "package.json": '{"dependencies":{"next":"15.0.0"}}',
        "app/page.jsx": "export default function Page() {}"
      })
    );
    expect(nextDetection.confidence).toBe(0.99);
    expect(nextjs.descriptor.requires).toEqual([]);

    for (const extension of [nextjs, fastify]) {
      const module = await extension.contribute({ spec, workspace: workspace({}) });
      expect(module.skills).toHaveLength(1);
      expect(module.instructions).toHaveLength(2);
      expect(module.source).toBe(extension.descriptor.id);
    }
  });
});
