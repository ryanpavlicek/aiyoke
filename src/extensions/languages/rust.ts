import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createLanguage, loaderFor } from "./shared.js";

export const rust = createLanguage({
  id: "rust",
  displayName: "Rust",
  description:
    "First-party Rust conventions emphasizing ownership, explicit errors, and safe concurrency.",
  capabilities: ["cargo", "ownership", "traits", "async"],
  fileExtensions: [".rs"],
  markerFiles: ["Cargo.toml", "Cargo.lock"],
  instructions: [
    "Keep ownership and borrowing explicit; prefer borrowing over cloning when it does not complicate the API.",
    "Use Result and Option with contextual errors rather than unwrap or expect on recoverable paths.",
    "Model states with enums and traits, and keep unsafe blocks minimal, documented, and justified.",
    "Use cargo fmt and cargo clippy conventions, and include unit or integration tests for changed behavior.",
    "Bound asynchronous work and preserve cancellation and backpressure semantics in services."
  ],
  pathPatterns: ["**/*.rs"],
  skillName: "rust-review",
  skillDescription: "Review Rust changes for ownership, error handling, API design, and tests.",
  skillBody:
    "Review Rust code and tests. Look for accidental clones, unchecked unwraps, unclear ownership, unnecessary unsafe, and missing error context. Check cargo fmt, clippy, and focused tests, keeping changes idiomatic and minimal."
});

export function createRustLanguageLoader(): ExtensionLoader<typeof rust> {
  return loaderFor(rust);
}

export const rustLanguageLoader = createRustLanguageLoader;
export const loader = createRustLanguageLoader();
