import type { SchemaDocument, SchemaMigration } from "../../application/index.js";
import { SchemaMigrationRegistry } from "../../application/index.js";
import { AiyokeError, type JsonObject } from "../../core/index.js";

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be an object.`);
  }
  return value as JsonObject;
}

export const compositionMigration: SchemaMigration = {
  id: "composition-v1-to-v2",
  fromVersion: 1,
  toVersion: 2,
  up(document) {
    if (document.schemaVersion !== 1) {
      throw new AiyokeError("INVALID_SPEC", "The composition migration requires schemaVersion 1.");
    }
    const stack = jsonObject(document.stack, "stack");
    const { stack: _legacyStack, ...rest } = document;
    return {
      ...rest,
      schemaVersion: 2,
      composition: { kind: "single", stack }
    } as SchemaDocument;
  },
  down(document) {
    if (document.schemaVersion !== 2) {
      throw new AiyokeError("INVALID_SPEC", "The composition rollback requires schemaVersion 2.");
    }
    const composition = jsonObject(document.composition, "composition");
    if (composition.kind !== "single") {
      throw new AiyokeError(
        "INVALID_SPEC",
        "A monorepo composition cannot be represented by schemaVersion 1. Restore a backup instead."
      );
    }
    const stack = jsonObject(composition.stack, "composition.stack");
    const { composition: _composition, ...rest } = document;
    return { ...rest, schemaVersion: 1, stack } as SchemaDocument;
  }
};

export function createSchemaMigrationRegistry(): SchemaMigrationRegistry {
  return new SchemaMigrationRegistry().register(compositionMigration).freeze();
}
