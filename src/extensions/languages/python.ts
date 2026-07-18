import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createLanguage, loaderFor } from "./shared.js";

export const python = createLanguage({
  id: "python",
  displayName: "Python",
  description: "First-party Python conventions for readable, typed, testable services and tools.",
  capabilities: ["typed-python", "pytest", "packaging", "asyncio"],
  fileExtensions: [".py", ".pyi"],
  markerFiles: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"],
  instructions: [
    "Target the supported Python version recorded by the project and prefer the standard library before adding dependencies.",
    "Use type hints on public functions, dataclasses or small domain objects for data, and explicit exceptions at boundaries.",
    "Keep I/O at the edges; make core logic deterministic and straightforward to exercise with pytest.",
    "Use async def only when the call chain is asynchronous, and never block an event loop with synchronous network or file I/O.",
    "Format with the repository's configured formatter and keep imports grouped and sorted."
  ],
  pathPatterns: ["**/*.py", "**/*.pyi"],
  skillName: "python-review",
  skillDescription: "Review Python changes for typing, tests, packaging, and async correctness.",
  skillBody:
    "Inspect the diff and its tests. Check public APIs have useful type hints, exceptions are intentional, async code does not block, and packaging metadata stays reproducible. Suggest the smallest safe fixes and run the project's Python test and format commands."
});

export function createPythonLanguageLoader(): ExtensionLoader<typeof python> {
  return loaderFor(python);
}

export const pythonLanguageLoader = createPythonLanguageLoader();
