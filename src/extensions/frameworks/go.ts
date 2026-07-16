import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createFramework, loaderFor } from "./shared.js";

const go = { kind: "language" as const, id: "go" };

export const chi = createFramework({
  id: "chi",
  displayName: "Chi",
  description: "Chi guidance for lightweight, composable Go HTTP services.",
  capabilities: ["http-api", "middleware", "routing", "stdlib"],
  requires: [go],
  markerFiles: ["go.mod", "go.work"],
  dependencyPatterns: ["go-chi/chi"],
  sourcePatterns: ["main.go", "routes.go", "handler.go"],
  instructions: [
    "Keep routers composable and middleware order visible; pass dependencies through constructors rather than package globals.",
    "Validate path, query, and JSON input at boundaries and return consistent status and error bodies.",
    "Honor request context cancellation and deadlines for every downstream call.",
    "Test route tables, middleware, malformed input, auth, and graceful shutdown with httptest."
  ],
  pathPatterns: ["**/*.go"],
  skillName: "chi-route",
  skillDescription: "Review Chi routers, middleware, context use, and httptest coverage.",
  skillBody:
    "Trace a Chi request through middleware and route handlers. Check dependency injection, validation, context cancellation, status envelopes, auth, and httptest coverage."
});

export const gin = createFramework({
  id: "gin",
  displayName: "Gin",
  description: "Gin guidance for performant, explicit Go web APIs.",
  capabilities: ["http-api", "middleware", "binding", "routing"],
  requires: [go],
  markerFiles: ["go.mod", "go.work"],
  dependencyPatterns: ["gin-gonic/gin"],
  sourcePatterns: ["main.go", "routes.go", "handler.go"],
  instructions: [
    "Keep handlers thin and inject services; avoid putting business rules in Gin context plumbing.",
    "Use binding and validation deliberately, distinguish client errors from server failures, and sanitize responses.",
    "Make middleware ordering explicit for request IDs, auth, logging, recovery, and timeouts.",
    "Test binding failures, auth, response codes, and shutdown paths with httptest."
  ],
  pathPatterns: ["**/*.go"],
  skillName: "gin-handler",
  skillDescription: "Review Gin handlers, binding, middleware, and error responses.",
  skillBody:
    "Review Gin routes in middleware order. Check binding and validation, auth, panic recovery, context propagation, stable errors, and focused httptest cases."
});

export const fiber = createFramework({
  id: "fiber",
  displayName: "Fiber",
  description: "Fiber guidance for fast, ergonomic Go services with explicit lifecycle management.",
  capabilities: ["http-api", "middleware", "routing", "performance"],
  requires: [go],
  markerFiles: ["go.mod", "go.work"],
  dependencyPatterns: ["gofiber/fiber"],
  sourcePatterns: ["main.go", "routes.go", "handler.go"],
  instructions: [
    "Respect Fiber's request-context lifecycle and copy data that must outlive the handler.",
    "Validate all external input and keep application services independent from Fiber-specific context APIs.",
    "Order security, auth, recovery, logging, and timeout middleware intentionally.",
    "Test malformed requests, status envelopes, concurrency-sensitive code, and graceful shutdown."
  ],
  pathPatterns: ["**/*.go"],
  skillName: "fiber-route",
  skillDescription: "Review Fiber routes, lifecycle boundaries, middleware, and tests.",
  skillBody:
    "Inspect Fiber handlers and middleware. Check context lifetime and data copies, validation, auth, recovery, stable responses, concurrency, and focused tests."
});

export function createChiFrameworkLoader(): ExtensionLoader<typeof chi> {
  return loaderFor(chi);
}
export function createGinFrameworkLoader(): ExtensionLoader<typeof gin> {
  return loaderFor(gin);
}
export function createFiberFrameworkLoader(): ExtensionLoader<typeof fiber> {
  return loaderFor(fiber);
}
export const chiFrameworkLoader = createChiFrameworkLoader;
export const ginFrameworkLoader = createGinFrameworkLoader;
export const fiberFrameworkLoader = createFiberFrameworkLoader;
export const chiLoader = createChiFrameworkLoader();
export const ginLoader = createGinFrameworkLoader();
export const fiberLoader = createFiberFrameworkLoader();
