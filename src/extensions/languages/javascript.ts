import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createLanguage, loaderFor } from "./shared.js";

export const javascript = createLanguage({
  id: "javascript",
  displayName: "JavaScript",
  description: "First-party JavaScript conventions for modern Node.js and browser code.",
  capabilities: ["ecmascript", "node", "web", "testing"],
  fileExtensions: [".js", ".jsx", ".mjs", ".cjs"],
  markerFiles: ["jsconfig.json"],
  instructions: [
    "Use the project's declared ECMAScript and module target; do not mix CommonJS and ESM conventions in one package.",
    "Prefer const, narrow function scopes, and explicit error handling over implicit global or mutable state.",
    "Validate external data before use and keep side effects behind small adapters that are easy to test.",
    "Use async/await with deliberate cancellation and error propagation; avoid unhandled promise rejections.",
    "Keep formatting and lint output clean, and add regression tests for behavior changes."
  ],
  pathPatterns: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  skillName: "javascript-review",
  skillDescription: "Review JavaScript changes for runtime safety, module consistency, and tests.",
  skillBody:
    "Inspect JavaScript changes and tests. Check module format, input validation, promise/error handling, side-effect boundaries, and deterministic behavior. Run the project's lint and test commands before proposing focused fixes."
});

export function createJavaScriptLanguageLoader(): ExtensionLoader<typeof javascript> {
  return loaderFor(javascript);
}

export const javascriptLanguageLoader = createJavaScriptLanguageLoader();
