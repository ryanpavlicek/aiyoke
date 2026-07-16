import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createFramework, loaderFor } from "./shared.js";

const rust = { kind: "language" as const, id: "rust" };

export const axum = createFramework({
  id: "axum",
  displayName: "Axum",
  description: "Axum guidance for typed, composable Rust HTTP services.",
  capabilities: ["http-api", "tower", "extractors", "async"],
  requires: [rust],
  markerFiles: ["Cargo.toml", "Cargo.lock"],
  dependencyPatterns: ["axum"],
  sourcePatterns: ["main.rs", "lib.rs", "routes.rs"],
  instructions: [
    "Compose routes and layers explicitly with extractors; keep handlers small and return typed responses.",
    "Share application state through controlled State values and avoid global mutable state.",
    "Map domain errors to intentional HTTP responses and preserve useful tracing context.",
    "Test routing, extraction failures, auth layers, cancellation, and graceful shutdown."
  ],
  pathPatterns: ["**/*.rs"],
  skillName: "axum-handler",
  skillDescription: "Review Axum handlers, extractors, layers, and error responses.",
  skillBody:
    "Trace an Axum request through routing, extractors, middleware layers, state, and response mapping. Check ownership, error context, auth, cancellation, and focused integration tests."
});

export const actix = createFramework({
  id: "actix",
  displayName: "Actix Web",
  description: "Actix Web guidance for resilient, asynchronous Rust services.",
  capabilities: ["http-api", "actors", "middleware", "async"],
  requires: [rust],
  markerFiles: ["Cargo.toml", "Cargo.lock"],
  dependencyPatterns: ["actix-web", "actix_web"],
  sourcePatterns: ["main.rs", "lib.rs", "handlers.rs"],
  instructions: [
    "Keep handlers focused on transport concerns and delegate domain behavior to testable services.",
    "Use typed extractors, validated payloads, and centralized ResponseError mappings for stable APIs.",
    "Configure middleware for security, tracing, compression, and timeouts without hiding ordering.",
    "Test actor and async boundaries, malformed requests, auth failures, and graceful server shutdown."
  ],
  pathPatterns: ["**/*.rs"],
  skillName: "actix-handler",
  skillDescription: "Review Actix Web handlers, extractors, middleware, and async behavior.",
  skillBody:
    "Inspect Actix routes and middleware in execution order. Check typed extraction, error mapping, auth, timeout and cancellation behavior, tracing, ownership, and integration tests."
});

export function createAxumFrameworkLoader(): ExtensionLoader<typeof axum> {
  return loaderFor(axum);
}
export function createActixFrameworkLoader(): ExtensionLoader<typeof actix> {
  return loaderFor(actix);
}
export const axumFrameworkLoader = createAxumFrameworkLoader;
export const actixFrameworkLoader = createActixFrameworkLoader;
export const axumLoader = createAxumFrameworkLoader();
export const actixLoader = createActixFrameworkLoader();
