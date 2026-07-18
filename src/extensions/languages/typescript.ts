import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createLanguage, loaderFor } from "./shared.js";

export const typescript = createLanguage({
  id: "typescript",
  displayName: "TypeScript",
  description:
    "First-party TypeScript conventions with strict, maintainable types and safe runtime boundaries.",
  capabilities: ["strict-types", "node", "web", "testing"],
  fileExtensions: [".ts", ".tsx", ".mts", ".cts"],
  markerFiles: ["tsconfig.json", "tsconfig.base.json"],
  dependencyPatterns: ["typescript"],
  instructions: [
    "Keep strict compiler checks enabled; model variants and lifecycle states with discriminated unions instead of broad casts.",
    "Validate untrusted input at runtime before treating it as a domain type, and keep adapters at the application boundary.",
    "Prefer small pure functions, readonly values, and explicit return types for exported APIs.",
    "Use ESM import specifiers and preserve the repository's module and path-alias conventions.",
    "Add focused tests for changed behavior and avoid suppressing diagnostics with any, ts-ignore, or non-null assertions."
  ],
  pathPatterns: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  skillName: "typescript-review",
  skillDescription:
    "Review TypeScript changes for type safety, module boundaries, and test coverage.",
  skillBody:
    "Review changed TypeScript and tests. Verify strict typing, runtime validation at boundaries, correct ESM imports, deterministic ordering, and no unnecessary any or assertions. Run the repository typecheck and focused tests."
});

export function createTypeScriptLanguageLoader(): ExtensionLoader<typeof typescript> {
  return loaderFor(typescript);
}

export const typescriptLanguageLoader = createTypeScriptLanguageLoader();
