import { safeRelativePath } from "../core/index.js";

const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "coverage"]);
const EXCLUDED_INTERNAL_PREFIXES = [".aiyoke/cache", ".aiyoke/tmp"] as const;
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

function atOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Return whether a repository path may cross the isolated-renderer boundary. */
export function isShareableWorkspacePath(path: string): boolean {
  const normalized = safeRelativePath(path).toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
  if (EXCLUDED_INTERNAL_PREFIXES.some((prefix) => atOrBelow(normalized, prefix))) return false;

  const name = segments.at(-1) ?? "";
  const secretEnvironmentFile =
    (name === ".env" || name.startsWith(".env.")) && !SAFE_ENV_TEMPLATES.has(name);
  return !secretEnvironmentFile;
}
