import type { ArtifactIntent, JsonValue, VerificationFinding } from "../../core/index.js";
import type {
  TargetExtension,
  TargetRenderContext,
  TargetVerificationContext
} from "../../extension-sdk/index.js";
import { artifact, sanitizeObject, stableJson } from "../shared/render.js";
import {
  descriptor,
  loaderFor,
  type TargetImplementation,
  verifyTarget
} from "../shared/target.js";

const ADAPTER = "xai-api";

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const target = context.target;
  const settings = target.kind === "api-provider" ? sanitizeObject(target.settings) : {};
  const protocol = target.kind === "api-provider" ? target.protocol : "chat-completions";
  const config = {
    schemaVersion: 1,
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    protocol,
    apiKeyEnvironmentVariable: "XAI_API_KEY",
    settings
  } as unknown as JsonValue;
  return [artifact(".xai/provider.json", stableJson(config), ADAPTER)];
}

async function verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]> {
  return verifyTarget(context, ADAPTER, "api-provider");
}

export const xaiApiTarget: TargetExtension = {
  descriptor: descriptor(
    ADAPTER,
    "xAI API",
    "xAI/Grok provider configuration with environment-referenced credentials.",
    ["api", "chat-completions", "responses"]
  ),
  surface: "api-provider",
  render,
  verify
};

export function createXaiApiLoader() {
  return loaderFor(xaiApiTarget as TargetImplementation);
}

export const grokApiTarget = xaiApiTarget;
export const createGrokApiLoader = createXaiApiLoader;
export const createXAILoader = createXaiApiLoader;
export const createXaiLoader = createXaiApiLoader;
export const createXaiApiTargetLoader = createXaiApiLoader;
export const xaiApiLoader = createXaiApiLoader();
export const grokApiLoader = xaiApiLoader;
export const xaiApiTargetLoader = xaiApiLoader;
export default createXaiApiLoader;
