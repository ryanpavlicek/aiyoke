import { describe, expect, it } from "vitest";
import { AiyokeError, extensionId, safeRelativePath } from "../../src/core/index.js";

describe("core identities", () => {
  it("accepts stable extension ids", () => {
    expect(extensionId("claude-code")).toBe("claude-code");
    expect(() => extensionId("ClaudeCode")).toThrow(AiyokeError);
  });

  it.each([
    "../secret",
    "/absolute",
    "C:\\outside",
    "a//b",
    "./file",
    "CON",
    "folder/trailing. ",
    ""
  ])("rejects unsafe generated path %j", (path) => {
    expect(() => safeRelativePath(path)).toThrow(AiyokeError);
  });

  it("normalizes safe Windows separators", () => {
    expect(safeRelativePath(".claude\\skills\\review.md")).toBe(".claude/skills/review.md");
  });
});
