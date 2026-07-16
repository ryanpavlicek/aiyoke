import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { aggregateHarnessStack } from "../../src/core/index.js";
import {
  createSchemaMigrationRegistry,
  defaultHarnessSpec,
  parseHarnessSpec,
  parseSchemaDocument,
  stringifySchemaDocument
} from "../../src/infrastructure/config/index.js";

function legacySource(): string {
  const current = defaultHarnessSpec("example");
  if (current.composition.kind !== "single") throw new Error("default must be single");
  return stringify({
    schemaVersion: 1,
    project: current.project,
    stack: current.composition.stack,
    targets: current.targets,
    packs: current.packs,
    generation: current.generation
  });
}

describe("built-in schema migrations", () => {
  it("migrates v1 to canonical v2 and reverses losslessly", () => {
    const registry = createSchemaMigrationRegistry();
    const legacy = parseSchemaDocument(legacySource());
    const upgraded = registry.migrate(legacy, 2);
    const spec = parseHarnessSpec(stringifySchemaDocument(upgraded.document));

    expect(spec.schemaVersion).toBe(2);
    expect(spec.composition).toEqual({
      kind: "single",
      stack: { languages: ["typescript"], frameworks: [] }
    });
    const downgraded = registry.migrate(upgraded.document, 1, { allowDowngrade: true });
    expect(downgraded.document).toEqual(legacy);
  });

  it("represents and aggregates rich monorepo composition", () => {
    const current = defaultHarnessSpec("polyglot");
    const spec = parseHarnessSpec(
      stringify({
        ...current,
        composition: {
          kind: "monorepo",
          root: { languages: ["typescript"], frameworks: [] },
          workspaces: [
            {
              id: "web",
              path: "apps/web",
              stack: { languages: ["typescript"], frameworks: ["nextjs"] }
            },
            {
              id: "api",
              path: "services/api",
              stack: { languages: ["python"], frameworks: ["fastapi"] }
            }
          ]
        }
      })
    );
    expect(aggregateHarnessStack(spec.composition)).toEqual({
      languages: ["typescript", "python"],
      frameworks: ["nextjs", "fastapi"]
    });
    expect(() =>
      createSchemaMigrationRegistry().migrate(parseSchemaDocument(stringify(spec)), 1, {
        allowDowngrade: true
      })
    ).toThrow(/cannot be represented/);
  });

  it("rejects malformed monorepo identities and paths", () => {
    const base = defaultHarnessSpec("invalid");
    const workspace = {
      id: "api",
      path: "apps/api",
      stack: { languages: ["go"], frameworks: ["gin"] }
    };
    const cases = [
      { kind: "monorepo", root: { languages: [], frameworks: [] }, workspaces: [] },
      {
        kind: "monorepo",
        root: { languages: [], frameworks: [] },
        workspaces: [workspace, { ...workspace, path: "apps/other" }]
      },
      {
        kind: "monorepo",
        root: { languages: [], frameworks: [] },
        workspaces: [workspace, { ...workspace, id: "other" }]
      },
      {
        kind: "monorepo",
        root: { languages: [], frameworks: [] },
        workspaces: [{ ...workspace, path: "../outside" }]
      }
    ];
    for (const composition of cases) {
      expect(() => parseHarnessSpec(stringify({ ...base, composition }))).toThrow();
    }
  });
});
