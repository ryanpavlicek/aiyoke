import { AiyokeError, safeRelativePath } from "../core/index.js";

const RESERVED_EXACT_PATHS = new Set(["aiyoke.yaml"]);
const RESERVED_PATH_PREFIXES = [".git", ".aiyoke/backups"] as const;

function portablePath(value: string): string {
  return value.toLowerCase();
}

function atOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Validate the sanctioned output channel used by extension renderers.
 *
 * `safeRelativePath` owns platform-independent syntax safety in core. This
 * application policy adds Aiyoke-specific ownership boundaries so extensions
 * cannot replace configuration, internal recovery state, Git control data, or
 * the compiler-owned lock file.
 */
export function extensionArtifactPath(path: string, lockFile: string): string {
  const normalized = safeRelativePath(path);
  const portable = portablePath(normalized);
  const portableLockFile = portablePath(safeRelativePath(lockFile));
  const reserved =
    RESERVED_EXACT_PATHS.has(portable) ||
    portable === portableLockFile ||
    RESERVED_PATH_PREFIXES.some((prefix) => atOrBelow(portable, prefix));

  if (reserved) {
    throw new AiyokeError(
      "INVALID_PATH",
      `Extension artifact path ${normalized} is reserved by Aiyoke or the repository.`,
      { path: normalized }
    );
  }
  return normalized;
}
