import type {
  ArtifactIntent,
  InferenceGatewayTarget,
  JsonValue,
  VerificationFinding
} from "../../core/index.js";
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

const ADAPTER = "openrouter";

async function render(context: TargetRenderContext): Promise<readonly ArtifactIntent[]> {
  const target = context.target as InferenceGatewayTarget;
  const settings = sanitizeObject(target.settings);
  // Chat Completions remains the wire-compatible default. Responses is explicitly opt-in
  // through settings.protocol so existing OpenRouter integrations stay stable.
  const protocol = settings.protocol === "responses" ? "responses" : "chat-completions";
  const config = {
    schemaVersion: 1,
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol,
    apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
    routing: target.routing,
    settings
  } as unknown as JsonValue;
  return [artifact(".openrouter/config.json", stableJson(config), ADAPTER)];
}

async function verify(context: TargetVerificationContext): Promise<readonly VerificationFinding[]> {
  const findings = [...verifyTarget(context, ADAPTER, "inference-gateway")];
  if (findings.length > 0) return findings;
  const target = context.target as InferenceGatewayTarget;
  const requestedProtocol = target.settings.protocol;
  if (
    requestedProtocol !== undefined &&
    requestedProtocol !== "responses" &&
    requestedProtocol !== "chat-completions"
  ) {
    findings.push({
      severity: "error",
      code: "INVALID_OPENROUTER_PROTOCOL",
      message: "OpenRouter protocol must be chat-completions or an explicit responses opt-in.",
      target: ADAPTER
    });
  }
  if (target.routing.kind === "fallback" && target.routing.models.length === 0) {
    findings.push({
      severity: "error",
      code: "EMPTY_FALLBACK_ROUTE",
      message: "OpenRouter fallback routing requires at least one model.",
      target: ADAPTER
    });
  }
  if (
    target.routing.kind === "fallback" &&
    target.routing.models.some((model) => model.trim().length === 0)
  ) {
    findings.push({
      severity: "error",
      code: "EMPTY_FALLBACK_MODEL",
      message: "OpenRouter fallback models must not be blank.",
      target: ADAPTER
    });
  }
  if (target.routing.kind === "fixed" && target.routing.model.trim().length === 0) {
    findings.push({
      severity: "error",
      code: "EMPTY_FIXED_ROUTE",
      message: "OpenRouter fixed routing requires a model.",
      target: ADAPTER
    });
  }
  if (target.routing.kind === "capability" && target.routing.providerOrder.length === 0) {
    findings.push({
      severity: "error",
      code: "EMPTY_PROVIDER_ORDER",
      message: "OpenRouter capability routing requires at least one provider.",
      target: ADAPTER
    });
  }
  return findings;
}

export const openRouterTarget: TargetExtension = {
  descriptor: descriptor(ADAPTER, "OpenRouter", "Dynamic model routing through OpenRouter.", [
    "gateway",
    "routing",
    "chat-completions",
    "responses"
  ]),
  surface: "inference-gateway",
  render,
  verify
};

export function createOpenRouterLoader() {
  return loaderFor(openRouterTarget as TargetImplementation);
}

export const openRouterLoader = createOpenRouterLoader();
