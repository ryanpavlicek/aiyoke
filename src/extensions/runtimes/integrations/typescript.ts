import type { FrameworkIntegrationDefinition } from "../shared.js";

const nextjs = `import type { HarnessRuntime, ModelRequest } from "../runtime.js";

export type NextRequestFactory = (request: Request) => ModelRequest | Promise<ModelRequest>;

function statusForFailure(kind: string): number {
  if (kind === "guard-rejected") return 400;
  if (kind === "approval-required") return 403;
  if (kind === "budget-exhausted" || kind === "rate-limit") return 429;
  if (kind === "cancelled") return 499;
  if (kind === "timeout") return 504;
  return 502;
}

export function createAiyokeNextRoute<T>(
  runtime: HarnessRuntime,
  requestFactory: NextRequestFactory
): (request: Request) => Promise<Response> {
  return async (request) => {
    const modelRequest = await requestFactory(request);
    const result = await runtime.execute<T>(modelRequest, { signal: request.signal });
    if (result.kind === "success") {
      return Response.json({ data: result.value, usage: result.usage });
    }
    return Response.json(
      { error: { kind: result.failure.kind, message: result.failure.message } },
      { status: statusForFailure(result.failure.kind) }
    );
  };
}
`;

const express = `import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { HarnessRuntime, ModelRequest } from "../runtime.js";

export type ExpressRequestFactory = (request: Request) => ModelRequest | Promise<ModelRequest>;

function statusForFailure(kind: string): number {
  if (kind === "guard-rejected") return 400;
  if (kind === "approval-required") return 403;
  if (kind === "budget-exhausted" || kind === "rate-limit") return 429;
  if (kind === "cancelled") return 499;
  if (kind === "timeout") return 504;
  return 502;
}

export function createAiyokeExpressHandler<T>(
  runtime: HarnessRuntime,
  requestFactory: ExpressRequestFactory
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const cancellation = new AbortController();
    request.once("close", () => cancellation.abort());
    try {
      const modelRequest = await requestFactory(request);
      const result = await runtime.execute<T>(modelRequest, { signal: cancellation.signal });
      if (result.kind === "success") {
        response.json({ data: result.value, usage: result.usage });
        return;
      }
      response.status(statusForFailure(result.failure.kind)).json({
        error: { kind: result.failure.kind, message: result.failure.message }
      });
    } catch (error) {
      next(error);
    }
  };
}
`;

const fastify = `import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { HarnessRuntime, ModelRequest } from "../runtime.js";

export type FastifyRequestFactory = (
  request: FastifyRequest
) => ModelRequest | Promise<ModelRequest>;

function statusForFailure(kind: string): number {
  if (kind === "guard-rejected") return 400;
  if (kind === "approval-required") return 403;
  if (kind === "budget-exhausted" || kind === "rate-limit") return 429;
  if (kind === "cancelled") return 499;
  if (kind === "timeout") return 504;
  return 502;
}

export function createAiyokeFastifyHandler<T>(
  runtime: HarnessRuntime,
  requestFactory: FastifyRequestFactory
): RouteHandlerMethod {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const cancellation = new AbortController();
    request.raw.once("close", () => cancellation.abort());
    const modelRequest = await requestFactory(request);
    const result = await runtime.execute<T>(modelRequest, { signal: cancellation.signal });
    if (result.kind === "success") {
      return reply.send({ data: result.value, usage: result.usage });
    }
    return reply.code(statusForFailure(result.failure.kind)).send({
      error: { kind: result.failure.kind, message: result.failure.message }
    });
  };
}
`;

const nestjs = `import { HttpException } from "@nestjs/common";
import type { HarnessRuntime, ModelRequest } from "../runtime.js";

export type NestRequestFactory<TInput> = (
  input: TInput,
  authorization: string | undefined
) => ModelRequest | Promise<ModelRequest>;

function statusForFailure(kind: string): number {
  if (kind === "guard-rejected") return 400;
  if (kind === "approval-required") return 403;
  if (kind === "budget-exhausted" || kind === "rate-limit") return 429;
  if (kind === "cancelled") return 499;
  if (kind === "timeout") return 504;
  return 502;
}

export function createAiyokeNestHandler<TInput, TOutput>(
  runtime: HarnessRuntime,
  requestFactory: NestRequestFactory<TInput>
): (input: TInput, authorization?: string, signal?: AbortSignal) => Promise<TOutput> {
  return async (input, authorization, signal) => {
    const request = await requestFactory(input, authorization);
    const result = await runtime.execute<TOutput>(request, { signal });
    if (result.kind === "success") return result.value;
    throw new HttpException(
      { error: { kind: result.failure.kind, message: result.failure.message } },
      statusForFailure(result.failure.kind)
    );
  };
}
`;

export const typeScriptIntegrations: readonly FrameworkIntegrationDefinition[] = [
  { framework: "nextjs", path: "integrations/nextjs.ts", source: nextjs },
  { framework: "nestjs", path: "integrations/nestjs.ts", source: nestjs },
  { framework: "fastify", path: "integrations/fastify.ts", source: fastify },
  { framework: "express", path: "integrations/express.ts", source: express }
];
