import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAiyokeExpressHandler } from "./integrations/express.ts";
import { createAiyokeFastifyHandler } from "./integrations/fastify.ts";
import { createAiyokeNestHandler } from "./integrations/nestjs.ts";
import { createAiyokeNextRoute } from "./integrations/nextjs.ts";
import type { HarnessRuntime } from "./runtime.ts";

const request = {
  requestId: "request-1",
  route: "primary",
  promptVersion: "v1",
  input: { question: "safe" },
  inputTokens: 4,
  maxOutputTokens: 16,
  metadata: { tenant: "fixture" }
};
const usage = { inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.001 };
const success = { kind: "success", value: { answer: 42 }, usage };
const failure = (kind: string) => ({
  kind: "failure",
  failure: { kind, message: `failure:${kind}`, retryable: false }
});
type Execute = (request: unknown, options: { signal?: AbortSignal }) => Promise<unknown>;
type AsyncHandler = (
  request: unknown,
  response: unknown,
  next: (error?: unknown) => void
) => Promise<void>;

const runtime = (execute: Execute) => ({ execute }) as unknown as HarnessRuntime;

const nextController = new AbortController();
let nextRequestSignal: AbortSignal | undefined;
const next = createAiyokeNextRoute(
  runtime(async (_request, options) => {
    assert.equal(options.signal, nextRequestSignal);
    return success;
  }),
  (incoming) => {
    assert.equal(incoming.headers.get("authorization"), "Bearer fixture");
    nextRequestSignal = incoming.signal;
    return request;
  }
);
const nextResponse = await next(
  new Request("https://example.test/ai", {
    headers: { authorization: "Bearer fixture" },
    signal: nextController.signal
  })
);
assert.equal(nextRequestSignal?.aborted, false);
assert.equal(nextResponse.status, 200);
assert.deepEqual(await nextResponse.json(), { data: { answer: 42 }, usage });

for (const [kind, status] of [
  ["guard-rejected", 400],
  ["approval-required", 403],
  ["budget-exhausted", 429],
  ["rate-limit", 429],
  ["cancelled", 499],
  ["timeout", 504],
  ["provider", 502]
] as const) {
  const route = createAiyokeNextRoute(
    runtime(async () => failure(kind)),
    () => request
  );
  assert.equal((await route(new Request("https://example.test/ai"))).status, status);
}

const nestController = new AbortController();
const nest = createAiyokeNestHandler(
  runtime(async (_request, options) => {
    assert.equal(options.signal, nestController.signal);
    return success;
  }),
  (input, authorization) => {
    assert.deepEqual(input, { question: "safe" });
    assert.equal(authorization, "Bearer fixture");
    return request;
  }
);
assert.deepEqual(
  await nest({ question: "safe" }, "Bearer fixture", nestController.signal),
  success.value
);
const rejectedNest = createAiyokeNestHandler(
  runtime(async () => failure("cancelled")),
  () => request
);
await assert.rejects(
  () => rejectedNest({}, undefined, undefined),
  (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "getStatus" in error &&
    typeof error.getStatus === "function" &&
    error.getStatus() === 499
);

function responseFixture() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
}

const expressRequest = Object.assign(new EventEmitter(), {
  headers: { authorization: "Bearer fixture" }
});
const expressResponse = responseFixture();
let expressForwarded: unknown;
const express = createAiyokeExpressHandler(
  runtime(async (_request, options) => {
    expressRequest.emit("close");
    assert.equal(options.signal.aborted, true);
    return success;
  }),
  (incoming) => {
    assert.equal(incoming.headers.authorization, "Bearer fixture");
    return request;
  }
) as unknown as AsyncHandler;
await express(expressRequest, expressResponse, (error: unknown) => {
  expressForwarded = error;
});
assert.equal(expressForwarded, undefined);
assert.deepEqual(expressResponse.body, { data: success.value, usage });

const expectedError = new Error("request factory failed");
const failingExpress = createAiyokeExpressHandler(
  runtime(async () => success),
  () => {
    throw expectedError;
  }
) as unknown as AsyncHandler;
await failingExpress(new EventEmitter(), responseFixture(), (error: unknown) => {
  expressForwarded = error;
});
assert.equal(expressForwarded, expectedError);

const fastifyRaw = new EventEmitter();
const fastifyReply = {
  statusCode: 200,
  body: undefined as unknown,
  code(code: number) {
    this.statusCode = code;
    return this;
  },
  send(body: unknown) {
    this.body = body;
    return this;
  }
};
const fastify = createAiyokeFastifyHandler(
  runtime(async (_request, options) => {
    fastifyRaw.emit("close");
    assert.equal(options.signal.aborted, true);
    return failure("approval-required");
  }),
  (incoming) => {
    assert.equal(incoming.headers.authorization, "Bearer fixture");
    return request;
  }
) as unknown as AsyncHandler;
await fastify({ raw: fastifyRaw, headers: { authorization: "Bearer fixture" } }, fastifyReply);
assert.equal(fastifyReply.statusCode, 403);
assert.deepEqual(fastifyReply.body, {
  error: { kind: "approval-required", message: "failure:approval-required" }
});

process.stdout.write("TypeScript framework request behavior passed.\n");
