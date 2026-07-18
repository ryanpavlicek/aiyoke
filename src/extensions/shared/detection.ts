import { compareCodePoints } from "../../core/index.js";
import type { WorkspaceSnapshot } from "../../extension-sdk/index.js";

export interface WorkspaceFileIndex {
  readonly files: readonly string[];
  readonly originalByNormalized: ReadonlyMap<string, string>;
}

export function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function indexWorkspaceFiles(workspace: WorkspaceSnapshot): WorkspaceFileIndex {
  const originalFiles = [...workspace.files].sort(
    (left, right) =>
      compareCodePoints(normalizeWorkspacePath(left), normalizeWorkspacePath(right)) ||
      compareCodePoints(left, right)
  );
  const originalByNormalized = new Map<string, string>();
  for (const file of originalFiles) {
    const normalized = normalizeWorkspacePath(file);
    if (!originalByNormalized.has(normalized)) originalByNormalized.set(normalized, file);
  }
  return { files: [...originalByNormalized.keys()], originalByNormalized };
}

export function matchesPathOrBasename(path: string, candidates: ReadonlySet<string>): boolean {
  return candidates.has(path) || candidates.has(path.split("/").at(-1) ?? "");
}
