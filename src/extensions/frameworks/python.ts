import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { createFramework, loaderFor } from "./shared.js";

const python = { kind: "language" as const, id: "python" };

export const fastapi = createFramework({
  id: "fastapi",
  displayName: "FastAPI",
  description: "FastAPI guidance for typed, asynchronous Python HTTP APIs.",
  capabilities: ["http-api", "openapi", "async", "dependency-injection"],
  requires: [python],
  markerFiles: ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py"],
  dependencyPatterns: ["fastapi"],
  sourcePatterns: ["main.py", "app.py", "routers.py"],
  instructions: [
    "Keep route handlers thin: validate request models, call application services, and map domain errors to HTTP responses.",
    "Use Pydantic models for external data and make dependency injection explicit and testable.",
    "Use async handlers only for async dependencies, and configure lifespan startup and shutdown deterministically.",
    "Keep OpenAPI metadata accurate and add endpoint tests for validation, authorization, and error responses."
  ],
  pathPatterns: ["**/*.py"],
  skillName: "fastapi-endpoint",
  skillDescription: "Design and review FastAPI endpoints with schemas, dependencies, and tests.",
  skillBody:
    "Trace the endpoint from request model through service and response model. Check validation, dependency overrides in tests, status codes, auth failures, OpenAPI metadata, and async resource cleanup."
});

export const django = createFramework({
  id: "django",
  displayName: "Django",
  description: "Django guidance for secure, maintainable full-stack Python applications.",
  capabilities: ["mvc", "orm", "admin", "migrations"],
  requires: [python],
  markerFiles: ["manage.py", "pyproject.toml", "requirements.txt", "setup.py"],
  dependencyPatterns: ["django"],
  sourcePatterns: ["manage.py", "urls.py", "views.py", "models.py"],
  instructions: [
    "Keep business rules out of views and templates; use cohesive application services and explicit model methods.",
    "Treat migrations as append-only production history, and review generated SQL for destructive or locking changes.",
    "Use Django's CSRF, authentication, ORM parameterization, and escaping defaults rather than bypassing them.",
    "Cover permissions, forms, serializers, and database behavior with isolated tests and transactional fixtures."
  ],
  pathPatterns: ["**/manage.py", "**/models.py", "**/views.py", "**/urls.py"],
  skillName: "django-change",
  skillDescription: "Review Django changes for migrations, security, and application boundaries.",
  skillBody:
    "Inspect models, migrations, views, URLs, and tests together. Check query count and indexes, migration safety, CSRF/auth permissions, escaping, and deterministic fixtures. Run focused Django tests."
});

export const flask = createFramework({
  id: "flask",
  displayName: "Flask",
  description: "Flask guidance for small, composable Python web services.",
  capabilities: ["http-api", "blueprints", "wsgi", "testing"],
  requires: [python],
  markerFiles: ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py"],
  dependencyPatterns: ["flask"],
  sourcePatterns: ["app.py", "application.py", "views.py"],
  instructions: [
    "Use an application factory and blueprints so configuration and route registration are explicit.",
    "Validate request payloads at the boundary and centralize error responses without leaking internals.",
    "Keep request context and global proxies out of core logic; inject collaborators for unit tests.",
    "Configure production WSGI servers, secret handling, and secure cookies outside development defaults."
  ],
  pathPatterns: ["**/*.py"],
  skillName: "flask-route",
  skillDescription: "Design and review Flask routes, factories, and request tests.",
  skillBody:
    "Trace routes through the application factory and blueprint. Check input validation, auth, error handlers, context usage, secure configuration, and tests for both success and failure paths."
});

export function createFastApiFrameworkLoader(): ExtensionLoader<typeof fastapi> {
  return loaderFor(fastapi);
}
export function createDjangoFrameworkLoader(): ExtensionLoader<typeof django> {
  return loaderFor(django);
}
export function createFlaskFrameworkLoader(): ExtensionLoader<typeof flask> {
  return loaderFor(flask);
}
export const fastApiFrameworkLoader = createFastApiFrameworkLoader;
export const djangoFrameworkLoader = createDjangoFrameworkLoader;
export const flaskFrameworkLoader = createFlaskFrameworkLoader;
export const fastapiLoader = createFastApiFrameworkLoader();
export const djangoLoader = createDjangoFrameworkLoader();
export const flaskLoader = createFlaskFrameworkLoader();
