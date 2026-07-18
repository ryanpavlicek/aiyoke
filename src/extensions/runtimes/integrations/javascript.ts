import type { FrameworkIntegrationDefinition } from "../shared.js";

export const javaScriptIntegrations: readonly FrameworkIntegrationDefinition[] = [
  {
    framework: "nextjs",
    path: "integrations/nextjs.js",
    source: `function statusForFailure(kind) {
    if (kind === "guard-rejected")
        return 400;
    if (kind === "approval-required")
        return 403;
    if (kind === "budget-exhausted" || kind === "rate-limit")
        return 429;
    if (kind === "cancelled")
        return 499;
    if (kind === "timeout")
        return 504;
    return 502;
}
export function createAiyokeNextRoute(runtime, requestFactory) {
    return async (request) => {
        const modelRequest = await requestFactory(request);
        const result = await runtime.execute(modelRequest, { signal: request.signal });
        if (result.kind === "success") {
            return Response.json({ data: result.value, usage: result.usage });
        }
        return Response.json({ error: { kind: result.failure.kind, message: result.failure.message } }, { status: statusForFailure(result.failure.kind) });
    };
}
`
  },
  {
    framework: "fastify",
    path: "integrations/fastify.js",
    source: `function statusForFailure(kind) {
    if (kind === "guard-rejected")
        return 400;
    if (kind === "approval-required")
        return 403;
    if (kind === "budget-exhausted" || kind === "rate-limit")
        return 429;
    if (kind === "cancelled")
        return 499;
    if (kind === "timeout")
        return 504;
    return 502;
}
export function createAiyokeFastifyHandler(runtime, requestFactory) {
    return async (request, reply) => {
        const cancellation = new AbortController();
        request.raw.once("close", () => cancellation.abort());
        const modelRequest = await requestFactory(request);
        const result = await runtime.execute(modelRequest, { signal: cancellation.signal });
        if (result.kind === "success") {
            return reply.send({ data: result.value, usage: result.usage });
        }
        return reply.code(statusForFailure(result.failure.kind)).send({
            error: { kind: result.failure.kind, message: result.failure.message }
        });
    };
}
`
  },
  {
    framework: "express",
    path: "integrations/express.js",
    source: `function statusForFailure(kind) {
    if (kind === "guard-rejected")
        return 400;
    if (kind === "approval-required")
        return 403;
    if (kind === "budget-exhausted" || kind === "rate-limit")
        return 429;
    if (kind === "cancelled")
        return 499;
    if (kind === "timeout")
        return 504;
    return 502;
}
export function createAiyokeExpressHandler(runtime, requestFactory) {
    return async (request, response, next) => {
        const cancellation = new AbortController();
        request.once("close", () => cancellation.abort());
        try {
            const modelRequest = await requestFactory(request);
            const result = await runtime.execute(modelRequest, { signal: cancellation.signal });
            if (result.kind === "success") {
                response.json({ data: result.value, usage: result.usage });
                return;
            }
            response.status(statusForFailure(result.failure.kind)).json({
                error: { kind: result.failure.kind, message: result.failure.message }
            });
        }
        catch (error) {
            next(error);
        }
    };
}
`
  }
];
