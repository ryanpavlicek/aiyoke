import type { SchemaDocument, SchemaMigration } from "../../application/index.js";
import { SchemaMigrationRegistry } from "../../application/index.js";
import { AiyokeError, DEFAULT_RUNTIME_HARNESS, type JsonObject } from "../../core/index.js";

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

export const runtimeHarnessMigration: SchemaMigration = {
  id: "runtime-harness-v2-to-v3",
  fromVersion: 2,
  toVersion: 3,
  up(document) {
    if (document.schemaVersion !== 2) {
      throw new AiyokeError("INVALID_SPEC", "The runtime migration requires schemaVersion 2.");
    }
    return {
      ...document,
      schemaVersion: 3,
      runtime: structuredClone(DEFAULT_RUNTIME_HARNESS)
    } as SchemaDocument;
  },
  down(document) {
    if (document.schemaVersion !== 3) {
      throw new AiyokeError("INVALID_SPEC", "The runtime rollback requires schemaVersion 3.");
    }
    const runtime = jsonObject(document.runtime, "runtime");
    if (runtime.kind !== "enabled") {
      throw new AiyokeError(
        "INVALID_SPEC",
        "Customized runtime configuration cannot be represented by schemaVersion 2. Restore a backup instead."
      );
    }
    const profile = jsonObject(runtime.profile, "runtime.profile");
    if (
      runtime.outputDirectory !== "aiyoke-runtime" ||
      profile.kind !== "production" ||
      Object.keys(runtime).length !== 3 ||
      Object.keys(profile).length !== 1
    ) {
      throw new AiyokeError(
        "INVALID_SPEC",
        "Customized runtime configuration cannot be represented by schemaVersion 2. Restore a backup instead."
      );
    }
    const { runtime: _runtime, ...rest } = document;
    return { ...rest, schemaVersion: 2 } as SchemaDocument;
  }
};

export function createSchemaMigrationRegistry(): SchemaMigrationRegistry {
  return new SchemaMigrationRegistry()
    .register(compositionMigration)
    .register(runtimeHarnessMigration)
    .freeze();
}
