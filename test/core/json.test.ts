import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/core/index.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively by Unicode code point while preserving arrays", () => {
    expect(
      canonicalJson({
        z: 1,
        nested: { b: true, a: null },
        "\u{10000}": "astral",
        "\uE000": "private-use",
        array: [{ y: 2, x: 1 }, "last"]
      })
    ).toBe(
      '{"array":[{"x":1,"y":2},"last"],"nested":{"a":null,"b":true},"z":1,"":"private-use","𐀀":"astral"}'
    );
  });

  it("is independent of insertion order and matches JSON number semantics", () => {
    expect(canonicalJson({ b: { d: 4, c: 3 }, a: -0 })).toBe(
      canonicalJson({ a: 0, b: { c: 3, d: 4 } })
    );
  });

  it.each([
    ["non-finite number", { value: Number.NaN }],
    ["undefined", { value: undefined }],
    ["bigint", { value: 1n }]
  ])("rejects %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects cycles without rejecting repeated non-cyclic references", () => {
    const shared = { value: 1 };
    expect(canonicalJson({ left: shared, right: shared })).toBe(
      '{"left":{"value":1},"right":{"value":1}}'
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });
});
