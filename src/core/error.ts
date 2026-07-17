import type { JsonObject } from "./json.js";

export const AIYOKE_ERROR_CODES = Object.freeze([
  "INVALID_SPEC",
  "INVALID_PATH",
  "EXTENSION_DUPLICATE",
  "EXTENSION_MISSING",
  "EXTENSION_CONFLICT",
  "EXTENSION_CYCLE",
  "EXTENSION_API_MISMATCH",
  "REGISTRY_FROZEN",
  "ARTIFACT_CONFLICT",
  "PLAN_CONFLICT",
  "WORKSPACE_IO",
  "VALIDATION_FAILED"
] as const);

export type AiyokeErrorCode = (typeof AIYOKE_ERROR_CODES)[number];

export class AiyokeError extends Error {
  readonly code: AiyokeErrorCode;
  readonly details: JsonObject;

  constructor(code: AiyokeErrorCode, message: string, details: JsonObject = {}) {
    super(message);
    this.name = "AiyokeError";
    this.code = code;
    this.details = details;
  }
}
