import { AiyokeError } from "./error.js";

export type ExtensionId = string & { readonly __extensionId: unique symbol };

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_WINDOWS_CHARACTERS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

function containsInvalidWindowsCharacter(value: string): boolean {
  return [...value].some(
    (character) => INVALID_WINDOWS_CHARACTERS.has(character) || (character.codePointAt(0) ?? 0) < 32
  );
}

export function extensionId(value: string): ExtensionId {
  if (!EXTENSION_ID_PATTERN.test(value)) {
    throw new AiyokeError(
      "INVALID_SPEC",
      `Invalid extension id "${value}". Use lower-case kebab-case.`,
      { value }
    );
  }
  return value as ExtensionId;
}

export function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const hasTraversal = parts.some((part) => part === "..");
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  const hasInvalidComponent = parts.some(
    (part) =>
      part.length === 0 ||
      part === "." ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      containsInvalidWindowsCharacter(part) ||
      WINDOWS_RESERVED_NAME.test(part)
  );

  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    isAbsolute ||
    hasTraversal ||
    hasInvalidComponent
  ) {
    throw new AiyokeError("INVALID_PATH", `Unsafe generated path "${value}".`, { value });
  }

  return normalized;
}
