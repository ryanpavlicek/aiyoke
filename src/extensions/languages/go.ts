import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createLanguage, loaderFor } from "./shared.js";

export const go = createLanguage({
  id: "go",
  displayName: "Go",
  description: "First-party Go conventions for simple, concurrent, observable services.",
  capabilities: ["modules", "goroutines", "interfaces", "testing"],
  fileExtensions: [".go"],
  markerFiles: ["go.mod", "go.work"],
  instructions: [
    "Keep packages small and cohesive; define interfaces at the consumer boundary and avoid speculative abstractions.",
    "Propagate errors with useful context and wrap them with %w so callers can inspect causes.",
    "Pass context.Context through I/O and server boundaries, honoring cancellation and deadlines.",
    "Guard shared state deliberately, bound goroutines, and make ownership of channels obvious.",
    "Run gofmt, go vet, and focused go test commands; table-driven tests are preferred for repeated cases."
  ],
  pathPatterns: ["**/*.go"],
  skillName: "go-review",
  skillDescription: "Review Go changes for package design, errors, concurrency, and tests.",
  skillBody:
    "Review Go changes and tests. Check error wrapping, context propagation, goroutine lifetimes, race-prone state, package boundaries, and deterministic behavior. Run gofmt, go vet, and focused go tests."
});

export function createGoLanguageLoader(): ExtensionLoader<typeof go> {
  return loaderFor(go);
}

export const goLanguageLoader = createGoLanguageLoader;
export const loader = createGoLanguageLoader();
