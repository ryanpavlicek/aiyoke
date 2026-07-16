import { describe, expect, it } from "vitest";
import {
  type SchemaDocument,
  type SchemaMigration,
  SchemaMigrationRegistry
} from "../../src/application/index.js";

function migration(fromVersion: number): SchemaMigration {
  const toVersion = fromVersion + 1;
  return {
    id: `v${fromVersion}-to-v${toVersion}`,
    fromVersion,
    toVersion,
    up: (document) => ({ ...document, schemaVersion: toVersion }),
    down: (document) => ({ ...document, schemaVersion: fromVersion })
  };
}

describe("SchemaMigrationRegistry", () => {
  it("runs adjacent migrations in order without mutating the source", () => {
    const registry = new SchemaMigrationRegistry().register(migration(2)).register(migration(1));
    const source: SchemaDocument = { schemaVersion: 1, marker: "original" };
    const result = registry.migrate(source, 3);

    expect(result.document).toEqual({ schemaVersion: 3, marker: "original" });
    expect(result.applied.map((item) => item.id)).toEqual(["v1-to-v2", "v2-to-v3"]);
    expect(source).toEqual({ schemaVersion: 1, marker: "original" });
    expect(registry.list().map((item) => item.id)).toEqual(["v1-to-v2", "v2-to-v3"]);
  });

  it("refuses implicit downgrades, gaps, invalid steps, duplicates, and frozen writes", () => {
    const registry = new SchemaMigrationRegistry().register(migration(1));
    expect(() => registry.migrate({ schemaVersion: 2 }, 1)).toThrow(/explicit permission/);
    expect(() => registry.migrate({ schemaVersion: 1 }, 3)).toThrow(/No registered migration/);
    expect(() => registry.register(migration(1))).toThrow(/already registered/);
    expect(() => new SchemaMigrationRegistry().register({ ...migration(1), toVersion: 4 })).toThrow(
      /exactly one/
    );
    registry.freeze();
    expect(() => registry.register(migration(2))).toThrow(/frozen/);
  });

  it("supports explicit reversible downgrades and validates step output", () => {
    const registry = new SchemaMigrationRegistry().register(migration(1));
    expect(
      registry.migrate({ schemaVersion: 2, marker: true }, 1, { allowDowngrade: true })
    ).toMatchObject({
      document: { schemaVersion: 1, marker: true },
      applied: [{ direction: "down", fromVersion: 2, toVersion: 1 }]
    });

    const corrupt = { ...migration(1), up: (document: SchemaDocument) => document };
    expect(() =>
      new SchemaMigrationRegistry().register(corrupt).migrate({ schemaVersion: 1 }, 2)
    ).toThrow(/produced schemaVersion/);
  });
});
