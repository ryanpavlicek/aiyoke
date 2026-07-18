import { compareCodePoints } from "./compare.js";
import type { HarnessModule } from "./model.js";

export interface ModuleDefinitionConflict {
  readonly kind: "skill" | "subagent" | "hook" | "mcp-server";
  readonly name: string;
  readonly modules: readonly string[];
}

export function moduleDefinitionConflicts(
  modules: readonly HarnessModule[]
): readonly ModuleDefinitionConflict[] {
  const definitions = [
    {
      kind: "skill" as const,
      values: modules.flatMap((module) =>
        module.skills.map((definition) => ({ module: module.id, name: definition.name }))
      )
    },
    {
      kind: "subagent" as const,
      values: modules.flatMap((module) =>
        module.subagents.map((definition) => ({ module: module.id, name: definition.name }))
      )
    },
    {
      kind: "hook" as const,
      values: modules.flatMap((module) =>
        module.hooks.map((definition) => ({ module: module.id, name: definition.id }))
      )
    },
    {
      kind: "mcp-server" as const,
      values: modules.flatMap((module) =>
        module.mcpServers.map((definition) => ({ module: module.id, name: definition.name }))
      )
    }
  ];
  const conflicts: ModuleDefinitionConflict[] = [];
  for (const { kind, values } of definitions) {
    const owners = new Map<string, string[]>();
    for (const { module, name } of values) {
      const current = owners.get(name) ?? [];
      current.push(module);
      owners.set(name, current);
    }
    for (const [name, ownerModules] of owners) {
      if (ownerModules.length < 2) continue;
      conflicts.push({ kind, name, modules: [...ownerModules].sort(compareCodePoints) });
    }
  }
  return conflicts.sort((left, right) =>
    compareCodePoints(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`)
  );
}
