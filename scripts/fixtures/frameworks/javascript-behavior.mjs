import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAiyokeExpressHandler } from "./integrations/express.js";
import { createAiyokeFastifyHandler } from "./integrations/fastify.js";
import { createAiyokeNextRoute } from "./integrations/nextjs.js";

const modelRequest = {
  requestId: "request-1",
  route: "primary",
  promptVersion: "v1",
  input: {},
  inputTokens: 1,
  maxOutputTokens: 2,
  metadata: {}
};
const usage = { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 };
const success = { kind: "success", value: "ok", usage };

const controller = new AbortController();
let requestSignal;
const next = createAiyokeNextRoute(
  {
    async execute(_request, options) {
      assert.equal(options.signal, requestSignal);
      return success;
    }
  },
  (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer fixture");
    requestSignal = request.signal;
    return modelRequest;
  }
);
const nextResponse = await next(
  new Request("https://example.test/ai", {
    headers: { authorization: "Bearer fixture" },
    signal: controller.signal
  })
);
assert.equal(nextResponse.status, 200);
assert.deepEqual(await nextResponse.json(), { data: "ok", usage });

function responseFixture() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

const expressRequest = Object.assign(new EventEmitter(), {
  headers: { authorization: "Bearer fixture" }
});
const expressResponse = responseFixture();
await createAiyokeExpressHandler(
  {
    async execute(_request, options) {
      expressRequest.emit("close");
      assert.equal(options.signal.aborted, true);
      return {
        kind: "failure",
        failure: { kind: "cancelled", message: "cancelled", retryable: false }
      };
    }
  },
  (request) => {
    assert.equal(request.headers.authorization, "Bearer fixture");
    return modelRequest;
  }
)(expressRequest, expressResponse, (error) => {
  throw error;
});
assert.equal(expressResponse.statusCode, 499);

const raw = new EventEmitter();
const reply = {
  statusCode: 200,
  body: undefined,
  code(code) {
    this.statusCode = code;
    return this;
  },
  send(body) {
    this.body = body;
    return this;
  }
};
await createAiyokeFastifyHandler(
  {
    async execute(_request, options) {
      raw.emit("close");
      assert.equal(options.signal.aborted, true);
      return success;
    }
  },
  () => modelRequest
)({ raw, headers: {} }, reply);
assert.deepEqual(reply.body, { data: "ok", usage });

process.stdout.write("JavaScript framework request behavior passed.\n");
