import type { FrameworkIntegrationDefinition } from "../shared.js";

const common = `from asyncio import CancelledError, create_task, sleep
from inspect import isawaitable
from runtime import FailureKind, ModelFailure


async def _resolve(value):
    return await value if isawaitable(value) else value


def _status(kind):
    if kind.value == "guard-rejected":
        return 400
    if kind.value == "approval-required":
        return 403
    if kind.value in {"budget-exhausted", "rate-limit"}:
        return 429
    if kind.value == "cancelled":
        return 499
    if kind.value == "timeout":
        return 504
    return 502


def _body(result):
    if isinstance(result, ModelFailure):
        return {"error": {"kind": result.kind.value, "message": result.message}}
    return {
        "data": result.value,
        "usage": {
            "inputTokens": result.usage.input_tokens,
            "outputTokens": result.usage.output_tokens,
            "estimatedCostUsd": result.usage.estimated_cost_usd,
        },
    }


async def _execute(runtime, model_request, cancellation_probe=None):
    task = create_task(runtime.execute(model_request))
    if cancellation_probe is None:
        return await task
    while not task.done():
        if await _resolve(cancellation_probe()):
            task.cancel()
            try:
                await task
            except CancelledError:
                pass
            return ModelFailure(
                FailureKind.CANCELLED,
                "the framework request was cancelled",
                False,
            )
        await sleep(0.01)
    return await task
`;

const fastapi = `from fastapi import Request
from fastapi.responses import JSONResponse

${common}

def create_aiyoke_fastapi_handler(runtime, request_factory, cancellation_probe_factory=None):
    async def endpoint(request: Request):
        model_request = await _resolve(request_factory(request))
        cancellation_probe = (
            cancellation_probe_factory(request)
            if cancellation_probe_factory is not None
            else request.is_disconnected
        )
        result = await _execute(runtime, model_request, cancellation_probe)
        status = _status(result.kind) if isinstance(result, ModelFailure) else 200
        return JSONResponse(_body(result), status_code=status)

    return endpoint
`;

const django = `from django.http import JsonResponse

${common}

def create_aiyoke_django_view(runtime, request_factory, cancellation_probe_factory=None):
    async def view(request):
        model_request = await _resolve(request_factory(request))
        cancellation_probe = (
            cancellation_probe_factory(request)
            if cancellation_probe_factory is not None
            else None
        )
        result = await _execute(runtime, model_request, cancellation_probe)
        status = _status(result.kind) if isinstance(result, ModelFailure) else 200
        return JsonResponse(_body(result), status=status)

    return view
`;

const flask = `from flask import jsonify, request

${common}

def create_aiyoke_flask_view(runtime, request_factory, cancellation_probe_factory=None):
    async def view():
        model_request = await _resolve(request_factory(request))
        cancellation_probe = (
            cancellation_probe_factory(request)
            if cancellation_probe_factory is not None
            else None
        )
        result = await _execute(runtime, model_request, cancellation_probe)
        status = _status(result.kind) if isinstance(result, ModelFailure) else 200
        return jsonify(_body(result)), status

    return view
`;

export const pythonIntegrations: readonly FrameworkIntegrationDefinition[] = [
  { framework: "fastapi", path: "fastapi_aiyoke.py", source: fastapi },
  { framework: "django", path: "django_aiyoke.py", source: django },
  { framework: "flask", path: "flask_aiyoke.py", source: flask }
];
