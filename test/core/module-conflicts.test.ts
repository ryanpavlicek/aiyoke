import { describe, expect, it } from "vitest";
import { type HarnessModule, moduleDefinitionConflicts } from "../../src/core/index.js";

function module(id: string): HarnessModule {
  return {
    id,
    title: id,
    source: id,
    instructions: [],
    skills: [],
    hooks: [],
    mcpServers: [],
    subagents: []
  };
}

describe("module definition conflicts", () => {
  it("reports every duplicate namespace deterministically", () => {
    const left = {
      ...module("left"),
      skills: [
        { name: "review", description: "x", body: "x", userInvocable: true, allowedTools: [] }
      ],
      hooks: [{ id: "guard", event: "pre-tool" as const, command: "check" }],
      mcpServers: [
        { name: "docs", transport: { kind: "stdio" as const, command: "mcp", args: [] } }
      ],
      subagents: [{ name: "reviewer", description: "x", prompt: "x", tools: [], readOnly: true }]
    };
    const right = { ...left, id: "right", source: "right" };
    expect(moduleDefinitionConflicts([right, left])).toEqual([
      { kind: "hook", name: "guard", modules: ["left", "right"] },
      { kind: "mcp-server", name: "docs", modules: ["left", "right"] },
      { kind: "skill", name: "review", modules: ["left", "right"] },
      { kind: "subagent", name: "reviewer", modules: ["left", "right"] }
    ]);
  });
});
