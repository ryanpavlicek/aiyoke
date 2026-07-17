import { compareCodePoints } from "./compare.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Deterministic JSON serialization with recursively code-point-sorted object keys. */
export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();

  const serialize = (entry: unknown): string => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      return JSON.stringify(entry);
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers.");
      }
      return JSON.stringify(entry);
    }
    if (typeof entry !== "object") {
      throw new TypeError("Canonical JSON contains a non-JSON value.");
    }
    if (ancestors.has(entry)) {
      throw new TypeError("Canonical JSON contains a cycle.");
    }

    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        return `[${entry.map((item) => serialize(item)).join(",")}]`;
      }
      return `{${Object.entries(entry)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(entry);
    }
  };

  return serialize(value);
}
