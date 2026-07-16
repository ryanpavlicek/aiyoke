import { AiyokeError, compareCodePoints, type JsonObject } from "../core/index.js";

export interface SchemaDocument extends JsonObject {
  readonly schemaVersion: number;
}

export interface SchemaMigration {
  readonly id: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  up(document: SchemaDocument): SchemaDocument;
  down(document: SchemaDocument): SchemaDocument;
}

export interface AppliedMigration {
  readonly id: string;
  readonly direction: "up" | "down";
  readonly fromVersion: number;
  readonly toVersion: number;
}

export interface SchemaMigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly document: SchemaDocument;
  readonly applied: readonly AppliedMigration[];
}

function version(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AiyokeError("INVALID_SPEC", `${label} must be a positive safe integer.`);
  }
  return value;
}

function assertDocumentVersion(
  document: SchemaDocument,
  expected: number,
  migrationId: string
): void {
  if (document.schemaVersion !== expected) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `Migration ${migrationId} produced schemaVersion ${document.schemaVersion}; expected ${expected}.`
    );
  }
}

export class SchemaMigrationRegistry {
  readonly #byFrom = new Map<number, SchemaMigration>();
  readonly #byTo = new Map<number, SchemaMigration>();
  #frozen = false;

  register(migration: SchemaMigration): this {
    if (this.#frozen) {
      throw new AiyokeError("REGISTRY_FROZEN", "The schema migration registry is frozen.");
    }
    const fromVersion = version(migration.fromVersion, `${migration.id}.fromVersion`);
    const toVersion = version(migration.toVersion, `${migration.id}.toVersion`);
    if (toVersion !== fromVersion + 1) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `Migration ${migration.id} must advance exactly one schema version.`
      );
    }
    if (this.#byFrom.has(fromVersion) || this.#byTo.has(toVersion)) {
      throw new AiyokeError(
        "EXTENSION_DUPLICATE",
        `A migration for schemaVersion ${fromVersion} to ${toVersion} is already registered.`
      );
    }
    this.#byFrom.set(fromVersion, migration);
    this.#byTo.set(toVersion, migration);
    return this;
  }

  freeze(): this {
    this.#frozen = true;
    return this;
  }

  get(fromVersion: number): SchemaMigration | undefined {
    return this.#byFrom.get(fromVersion);
  }

  list(): readonly SchemaMigration[] {
    return [...this.#byFrom.values()].sort((left, right) =>
      compareCodePoints(
        `${left.fromVersion.toString().padStart(10, "0")}:${left.id}`,
        `${right.fromVersion.toString().padStart(10, "0")}:${right.id}`
      )
    );
  }

  migrate(
    source: SchemaDocument,
    targetVersion: number,
    options: { readonly allowDowngrade?: boolean } = {}
  ): SchemaMigrationResult {
    const target = version(targetVersion, "targetVersion");
    const initial = version(source.schemaVersion, "schemaVersion");
    if (target < initial && options.allowDowngrade !== true) {
      throw new AiyokeError(
        "INVALID_SPEC",
        `Refusing to downgrade schemaVersion ${initial} to ${target} without explicit permission.`
      );
    }

    let document = structuredClone(source);
    const applied: AppliedMigration[] = [];
    while (document.schemaVersion !== target) {
      const current = version(document.schemaVersion, "schemaVersion");
      const direction = current < target ? "up" : "down";
      const migration = direction === "up" ? this.#byFrom.get(current) : this.#byTo.get(current);
      if (migration === undefined) {
        throw new AiyokeError(
          "INVALID_SPEC",
          `No registered migration can move schemaVersion ${current} ${direction}.`
        );
      }
      const next = direction === "up" ? migration.toVersion : migration.fromVersion;
      document = direction === "up" ? migration.up(document) : migration.down(document);
      assertDocumentVersion(document, next, migration.id);
      applied.push({
        id: migration.id,
        direction,
        fromVersion: current,
        toVersion: next
      });
      if (applied.length > this.#byFrom.size + 1) {
        throw new AiyokeError("INVALID_SPEC", "Schema migration registry contains a cycle.");
      }
    }

    return { fromVersion: initial, toVersion: target, document, applied };
  }
}
