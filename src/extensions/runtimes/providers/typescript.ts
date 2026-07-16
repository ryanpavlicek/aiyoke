import type { ProviderIntegrationDefinition } from "../shared.js";

const responses = `import type {
  AdapterRegistry,
  ModelAdapter,
  ModelFailure,
  ModelRequest,
  ModelResult,
  Usage
} from "../runtime.js";

export interface ResponsesInput {
  readonly input: string | readonly Readonly<Record<string, unknown>>[];
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  readonly text?: Readonly<Record<string, unknown>>;
  readonly reasoning?: Readonly<Record<string, unknown>>;
}

export interface ResponsesOutput {
  readonly id: string;
  readonly status: string;
  readonly text: string;
  readonly output: readonly unknown[];
}

export interface ResponsesAdapterConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnvironment: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly inputCostPerMillionTokens?: number;
  readonly outputCostPerMillionTokens?: number;
  readonly costTickDivisor?: number;
  readonly maxResponseBytes?: number;
}

export type ResponsesProvider = "openrouter" | "xai";

export type SecretResolver = (environmentVariable: string) => string | undefined;
export type FetchPort = typeof fetch;

const defaultMaxResponseBytes = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerFailure(
  message: string,
  retryable: boolean,
  providerCode?: string,
  secret?: string
): ModelResult<never> {
  const safeMessage = secret === undefined || secret.length === 0 ? message : message.split(secret).join("[REDACTED]");
  const safeCode =
    providerCode === undefined || secret === undefined || secret.length === 0
      ? providerCode
      : providerCode.split(secret).join("[REDACTED]");
  const failure: ModelFailure = {
    kind: "provider",
    message: safeMessage,
    retryable,
    ...(safeCode === undefined ? {} : { providerCode: safeCode })
  };
  return { kind: "failure", failure };
}

function responseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return "";
  const text: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        text.push(content.text);
      }
    }
  }
  return text.join("");
}

function usage(payload: Record<string, unknown>, config: ResponsesAdapterConfig): Usage {
  const raw = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : 0;
  const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : 0;
  const ticks = typeof raw.cost_in_usd_ticks === "number" ? raw.cost_in_usd_ticks : undefined;
  const estimatedCostUsd =
    ticks !== undefined && config.costTickDivisor !== undefined && config.costTickDivisor > 0
      ? ticks / config.costTickDivisor
      : (inputTokens * (config.inputCostPerMillionTokens ?? 0) +
          outputTokens * (config.outputCostPerMillionTokens ?? 0)) /
        1_000_000;
  return { inputTokens, outputTokens, estimatedCostUsd };
}

function validateEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username !== "" || url.password !== "") throw new TypeError("endpoint must not contain credentials");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("endpoint must use HTTPS except for local tests");
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number
): Promise<{ readonly kind: "body"; readonly value: string } | { readonly kind: "too-large" }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { kind: "too-large" };
  if (response.body === null) return { kind: "body", value: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "body", value: new TextDecoder().decode(body) };
}

export function responsesAdapterConfig(
  provider: ResponsesProvider,
  model: string,
  overrides: Partial<Omit<ResponsesAdapterConfig, "endpoint" | "model" | "apiKeyEnvironment">> = {}
): ResponsesAdapterConfig {
  return {
    endpoint:
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1/responses"
        : "https://api.x.ai/v1/responses",
    model,
    apiKeyEnvironment: provider === "openrouter" ? "OPENROUTER_API_KEY" : "XAI_API_KEY",
    ...(provider === "xai" ? { costTickDivisor: 10_000_000_000 } : {}),
    ...overrides
  };
}

export class ResponsesApiAdapter implements ModelAdapter {
  constructor(
    readonly config: ResponsesAdapterConfig,
    readonly resolveSecret: SecretResolver,
    readonly fetchPort: FetchPort = fetch
  ) {
    validateEndpoint(config.endpoint);
    if (config.model.trim().length === 0) throw new TypeError("model must not be empty");
    if (config.apiKeyEnvironment.trim().length === 0) {
      throw new TypeError("apiKeyEnvironment must not be empty");
    }
    if (
      config.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0)
    ) {
      throw new TypeError("maxResponseBytes must be a positive safe integer");
    }
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResult<unknown>> {
    if (!isRecord(request.input)) {
      return providerFailure("Responses API input must be an object.", false, "invalid_input");
    }
    const input = request.input as unknown as ResponsesInput;
    if (typeof input.input !== "string" && !Array.isArray(input.input)) {
      return providerFailure("Responses API input.input must be text or an item array.", false, "invalid_input");
    }
    const apiKey = this.resolveSecret(this.config.apiKeyEnvironment);
    if (apiKey === undefined || apiKey.length === 0) {
      return providerFailure(
        "The configured API key environment variable is unavailable.",
        false,
        "missing_credentials"
      );
    }
    let response: Response;
    try {
      response = await this.fetchPort(this.config.endpoint, {
        method: "POST",
        signal,
        headers: {
          ...(this.config.headers ?? {}),
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: this.config.model,
          input: input.input,
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
          max_output_tokens: request.maxOutputTokens,
          store: false,
          stream: false
        })
      });
    } catch (error) {
      if (signal.aborted) {
        return {
          kind: "failure",
          failure: { kind: "cancelled", message: "The provider request was cancelled.", retryable: false }
        };
      }
      return providerFailure(
        error instanceof Error ? error.message : "The provider request failed.",
        true,
        "network_error",
        apiKey
      );
    }
    let body;
    try {
      body = await readResponseBody(response, this.config.maxResponseBytes ?? defaultMaxResponseBytes);
    } catch (error) {
      return providerFailure(
        error instanceof Error ? error.message : "The provider response could not be read.",
        true,
        "response_read_error",
        apiKey
      );
    }
    if (body.kind === "too-large") {
      return providerFailure(
        "The provider response exceeded the size limit.",
        false,
        "response_too_large"
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.value);
    } catch {
      return providerFailure("The provider returned invalid JSON.", false, "invalid_response");
    }
    const record = isRecord(payload) ? payload : {};
    if (!response.ok || record.error != null || record.status === "failed") {
      const error = isRecord(record.error) ? record.error : {};
      const message = typeof error.message === "string" ? error.message : "The provider rejected the request.";
      const code =
        typeof record.error_type === "string"
          ? record.error_type
          : typeof error.code === "string"
            ? error.code
            : String(response.status);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      return providerFailure(message, retryable, code, apiKey);
    }
    return {
      kind: "success",
      value: {
        id: typeof record.id === "string" ? record.id : "",
        status: typeof record.status === "string" ? record.status : "completed",
        text: responseText(record),
        output: Array.isArray(record.output) ? record.output : []
      } satisfies ResponsesOutput,
      usage: usage(record, this.config)
    };
  }
}


export function registerResponsesAdapter(
  registry: AdapterRegistry,
  route: string,
  config: ResponsesAdapterConfig,
  resolveSecret: SecretResolver,
  fetchPort: FetchPort = fetch
): ResponsesApiAdapter {
  const adapter = new ResponsesApiAdapter(config, resolveSecret, fetchPort);
  registry.register(route, adapter);
  return adapter;
}
`;

const tests = `import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry } from "../runtime.js";
import {
  ResponsesApiAdapter,
  registerResponsesAdapter,
  responsesAdapterConfig
} from "./responses.js";

const request = {
  id: "provider-1",
  route: "primary",
  promptVersion: "v1",
  input: { input: "hello" },
  inputTokens: 1,
  maxOutputTokens: 20,
  metadata: {}
};

test("maps Responses API output, usage, and registration", async () => {
  let authorization = "";
  let body: Record<string, unknown> = {};
  const fetchPort: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "response-1",
        status: "completed",
        error: null,
        output_text: "world",
        output: [],
        usage: { input_tokens: 2, output_tokens: 3 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const registry = new AdapterRegistry();
  const adapter = registerResponsesAdapter(
    registry,
    "primary",
    responsesAdapterConfig("openrouter", "test/model", {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 2
    }),
    () => "test-secret",
    fetchPort
  );
  assert.equal(registry.get("primary"), adapter);
  const result = await adapter.invoke(request, new AbortController().signal);
  assert.equal(result.kind, "success");
  if (result.kind === "success") {
    assert.deepEqual(result.value, {
      id: "response-1",
      status: "completed",
      text: "world",
      output: []
    });
    assert.equal(result.usage.estimatedCostUsd, 0.000008);
  }
  assert.equal(authorization, "Bearer test-secret");
  assert.deepEqual(body, {
    model: "test/model",
    input: "hello",
    max_output_tokens: 20,
    store: false,
    stream: false
  });
});

test("classifies retryable errors and redacts credentials", async () => {
  const secret = "credential-that-must-not-leak";
  const adapter = new ResponsesApiAdapter(
    responsesAdapterConfig("xai", "grok-test"),
    () => secret,
    async () =>
      new Response(JSON.stringify({ error: { message: "rejected " + secret, code: secret } }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      })
  );
  const result = await adapter.invoke(request, new AbortController().signal);
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.failure.retryable, true);
    assert.equal(JSON.stringify(result), JSON.stringify(result).replace(secret, "[REDACTED]"));
  }
});

test("fails closed for missing credentials and unsafe endpoints", async () => {
  const adapter = new ResponsesApiAdapter(
    responsesAdapterConfig("openrouter", "test/model"),
    () => undefined,
    async () => {
      throw new Error("must not be called");
    }
  );
  const result = await adapter.invoke(request, new AbortController().signal);
  assert.equal(result.kind === "failure" ? result.failure.providerCode : "", "missing_credentials");
  assert.throws(
    () =>
      new ResponsesApiAdapter(
        { ...responsesAdapterConfig("openrouter", "test/model"), endpoint: "http://example.com" },
        () => "secret"
      ),
    /HTTPS/
  );
});

test("rejects malformed and oversized responses without buffering past the limit", async () => {
  const malformed = new ResponsesApiAdapter(
    responsesAdapterConfig("openrouter", "test/model"),
    () => "secret",
    async () => new Response("not-json", { status: 200 })
  );
  const malformedResult = await malformed.invoke(request, new AbortController().signal);
  assert.equal(
    malformedResult.kind === "failure" ? malformedResult.failure.providerCode : "",
    "invalid_response"
  );

  const oversized = new ResponsesApiAdapter(
    responsesAdapterConfig("openrouter", "test/model", { maxResponseBytes: 8 }),
    () => "secret",
    async () => new Response("123456789", { status: 200 })
  );
  const oversizedResult = await oversized.invoke(request, new AbortController().signal);
  assert.equal(
    oversizedResult.kind === "failure" ? oversizedResult.failure.providerCode : "",
    "response_too_large"
  );
});
`;

export const typeScriptProviders: readonly ProviderIntegrationDefinition[] = [
  {
    targets: ["openrouter", "xai-api"],
    artifacts: [
      { path: "providers/responses.ts", source: responses },
      { path: "providers/responses.test.ts", source: tests }
    ]
  }
];
