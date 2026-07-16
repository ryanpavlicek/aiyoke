import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The checker is a JavaScript CLI module and intentionally has no runtime
// dependency on the application. Vitest can still exercise its exported
// policy API directly.
// @ts-expect-error JavaScript helper has no generated declaration file.
import { checkArchitecture, extractStaticImports } from "../../scripts/check-architecture.mjs";

const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aiyoke-architecture-"));
  temporaryRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, "src", relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("architecture checker", () => {
  it("accepts the intended downward dependency direction and lazy public API", () => {
    const root = fixture({
      "core/value.ts": "export const value = 1;",
      "extension-sdk/contracts.ts":
        'import type { JsonValue } from "../core/value.js"; export type Contract = JsonValue;',
      "application/service.ts":
        'import type { Contract } from "../extension-sdk/contracts.js"; export type Service = Contract;',
      "infrastructure/filesystem/store.ts":
        'import type { Service } from "../../application/service.js"; export type Store = Service;',
      "engine/compose.ts":
        'import type { Store } from "../infrastructure/filesystem/store.js"; export type Engine = Store;',
      "extensions/shared/helpers.ts":
        'import type { Contract } from "../../extension-sdk/contracts.js"; export type Helper = Contract;',
      "extensions/targets/demo.ts":
        'import type { Helper } from "../shared/helpers.js"; export type Target = Helper;',
      "index.ts":
        'export type { Contract } from "./extension-sdk/contracts.js"; export async function load() { return import("./engine/compose.js"); }'
    });

    const result = checkArchitecture({ root });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("reports forbidden layer edges, including heavy public API imports", () => {
    const root = fixture({
      "core/value.ts":
        'import type { Service } from "../application/service.js"; export type Value = Service;',
      "application/service.ts":
        'import type { Store } from "../infrastructure/filesystem/store.js"; export type Service = Store;',
      "infrastructure/filesystem/store.ts": "export type Store = string;",
      "extensions/targets/demo.ts":
        'import type { Service } from "../../application/service.js"; export type Target = Service;',
      "engine/compose.ts": "export type Engine = string;",
      "index.ts": 'export { Engine } from "./engine/compose.js";'
    });

    const result = checkArchitecture({ root });
    expect(result.ok).toBe(false);
    expect(
      result.violations.map(
        ({ fromLayer, toLayer }: { fromLayer: string; toLayer: string }) =>
          `${fromLayer}->${toLayer}`
      )
    ).toEqual([
      "application->infrastructure",
      "core->application",
      "extensions-targets->application",
      "public-api->engine"
    ]);
  });

  it("extracts static imports but ignores comments and dynamic imports", () => {
    const imports = extractStaticImports(
      `// import bad from "./comment";
       import type { Core } from "./core.js";
       export { Core as Value } from "./core.js";
       const lazy = import("./heavy.js");
       const text = "import nope from './string'";`,
      "fixture.ts"
    );
    expect(imports).toEqual(["./core.js", "./core.js"]);
  });

  it("keeps infrastructure and engine independent from interfaces", () => {
    const root = fixture({
      "interfaces/cli.ts": "export type Cli = string;",
      "infrastructure/filesystem/store.ts":
        'import type { Cli } from "../../interfaces/cli.js"; export type Store = Cli;',
      "engine/compose.ts":
        'import type { Cli } from "../interfaces/cli.js"; export type Engine = Cli;'
    });

    const result = checkArchitecture({ root });
    expect(
      result.violations.map(
        ({ fromLayer, toLayer }: { fromLayer: string; toLayer: string }) =>
          `${fromLayer}->${toLayer}`
      )
    ).toEqual(["engine->interfaces", "infrastructure->interfaces"]);
  });
});
