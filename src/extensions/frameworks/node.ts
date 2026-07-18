import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createFramework, loaderFor } from "./shared.js";

const typescript = { kind: "language" as const, id: "typescript" };

export const nextjs = createFramework({
  id: "nextjs",
  displayName: "Next.js",
  description: "Next.js guidance for performant, secure React applications and route handlers.",
  capabilities: ["react", "app-router", "server-rendering", "route-handlers"],
  requires: [],
  markerFiles: ["package.json", "next.config.js", "next.config.mjs", "next.config.ts"],
  dependencyPatterns: ['"next"', "'next'"],
  sourcePatterns: ["/page.tsx", "/page.jsx", "/route.ts", "/route.js"],
  instructions: [
    "Choose server or client components deliberately; keep secrets, database access, and privileged work on the server.",
    "Use route handlers and server actions with explicit input validation, authorization, and cache or revalidation semantics.",
    "Keep loading and error states accessible, and avoid unnecessary client JavaScript and waterfall data fetching.",
    "Test navigation, metadata, auth boundaries, and rendering behavior in the project's supported browser and Node targets."
  ],
  pathPatterns: ["**/app/**", "**/pages/**", "**/*.tsx", "**/*.jsx"],
  skillName: "nextjs-route",
  skillDescription:
    "Review Next.js routes and components for server boundaries, caching, and accessibility.",
  skillBody:
    "Trace a Next.js page or route across server/client boundaries. Check validation and authorization, cache invalidation, loading/error states, metadata, accessibility, and tests without exposing secrets to the browser."
});

export const nestjs = createFramework({
  id: "nestjs",
  displayName: "NestJS",
  description: "NestJS guidance for modular, typed Node.js services.",
  capabilities: ["modules", "dependency-injection", "http-api", "testing"],
  requires: [typescript],
  markerFiles: ["package.json", "nest-cli.json"],
  dependencyPatterns: ['"@nestjs/core"', "'@nestjs/core'"],
  sourcePatterns: [".controller.ts", ".module.ts", ".service.ts"],
  instructions: [
    "Keep modules cohesive and expose only the providers and ports other modules need.",
    "Use DTO validation pipes at HTTP boundaries and map domain failures to stable transport errors.",
    "Keep controllers thin, services testable, and infrastructure providers behind explicit tokens or interfaces.",
    "Cover guards, interceptors, serialization, and persistence with focused unit and integration tests."
  ],
  pathPatterns: ["**/*.controller.ts", "**/*.module.ts", "**/*.service.ts"],
  skillName: "nestjs-module",
  skillDescription: "Review NestJS modules, providers, DTOs, and request boundaries.",
  skillBody:
    "Trace a NestJS request through guards, pipes, controller, service, and persistence. Check module ownership, DTO validation, auth, error mapping, provider testability, and focused integration tests."
});

export const fastify = createFramework({
  id: "fastify",
  displayName: "Fastify",
  description: "Fastify guidance for schema-first, high-throughput Node.js APIs.",
  capabilities: ["http-api", "json-schema", "plugins", "observability"],
  requires: [],
  markerFiles: ["package.json", "fastify.config.js"],
  dependencyPatterns: ['"fastify"', "'fastify'"],
  sourcePatterns: ["server.ts", "server.js", "routes.ts", "routes.js"],
  instructions: [
    "Define request and response schemas for every route and keep schemas aligned with runtime behavior.",
    "Use encapsulated plugins for boundaries such as auth, persistence, and telemetry; avoid hidden global state.",
    "Handle errors centrally with stable status codes while preserving correlation IDs and useful logs.",
    "Exercise hooks, validation failures, graceful shutdown, and backpressure in integration tests."
  ],
  pathPatterns: ["**/*.{ts,js,mts,mjs}"],
  skillName: "fastify-route",
  skillDescription: "Design and review Fastify schemas, plugins, and lifecycle hooks.",
  skillBody:
    "Review a Fastify route with its schema and plugin scope. Check validation, serialization, auth hooks, error handling, observability, shutdown, and tests for malformed and valid requests."
});

export const express = createFramework({
  id: "express",
  displayName: "Express",
  description: "Express guidance for explicit, secure Node.js middleware and HTTP services.",
  capabilities: ["http-api", "middleware", "routing", "testing"],
  requires: [],
  markerFiles: ["package.json"],
  dependencyPatterns: ['"express"', "'express'"],
  sourcePatterns: ["app.ts", "app.js", "server.ts", "server.js", "routes.ts", "routes.js"],
  instructions: [
    "Order middleware deliberately: security and request IDs first, parsing and auth before handlers, and error handling last.",
    "Validate external input and keep route handlers thin; never trust req.body, req.params, or req.query without a schema.",
    "Propagate async errors consistently and return stable error envelopes without exposing stack traces.",
    "Test middleware ordering, auth failures, malformed input, graceful shutdown, and important status codes."
  ],
  pathPatterns: ["**/*.{ts,js,mts,mjs}"],
  skillName: "express-route",
  skillDescription: "Review Express middleware ordering, validation, and error handling.",
  skillBody:
    "Trace the request through Express middleware and router boundaries. Check security headers, parsing, validation, auth, async error propagation, stable responses, and focused supertest-style coverage."
});

export function createNextJsFrameworkLoader(): ExtensionLoader<typeof nextjs> {
  return loaderFor(nextjs);
}
export function createNestJsFrameworkLoader(): ExtensionLoader<typeof nestjs> {
  return loaderFor(nestjs);
}
export function createFastifyFrameworkLoader(): ExtensionLoader<typeof fastify> {
  return loaderFor(fastify);
}
export function createExpressFrameworkLoader(): ExtensionLoader<typeof express> {
  return loaderFor(express);
}
export const nextJsFrameworkLoader = createNextJsFrameworkLoader();
export const nestJsFrameworkLoader = createNestJsFrameworkLoader();
export const fastifyFrameworkLoader = createFastifyFrameworkLoader();
export const expressFrameworkLoader = createExpressFrameworkLoader();
