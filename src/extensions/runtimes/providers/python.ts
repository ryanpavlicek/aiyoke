import type { ProviderIntegrationDefinition } from "../shared.js";

const responses = `from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from runtime import AdapterRegistry, FailureKind, ModelFailure, ModelRequest, ModelSuccess, Usage


SecretResolver = Callable[[str], str | None]


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


class HttpPort(Protocol):
    async def post_json(
        self, endpoint: str, headers: Mapping[str, str], body: bytes, timeout_seconds: float,
        max_response_bytes: int
    ) -> HttpResponse: ...


class UrlLibHttpPort:
    async def post_json(
        self, endpoint: str, headers: Mapping[str, str], body: bytes, timeout_seconds: float,
        max_response_bytes: int
    ) -> HttpResponse:
        return await asyncio.to_thread(
            self._post_json, endpoint, headers, body, timeout_seconds, max_response_bytes
        )

    @staticmethod
    def _post_json(
        endpoint: str, headers: Mapping[str, str], body: bytes, timeout_seconds: float,
        max_response_bytes: int
    ) -> HttpResponse:
        request = Request(endpoint, data=body, headers=dict(headers), method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                return HttpResponse(response.status, response.read(max_response_bytes + 1))
        except HTTPError as error:
            return HttpResponse(error.code, error.read(max_response_bytes + 1))


@dataclass(frozen=True)
class ResponsesAdapterConfig:
    endpoint: str
    model: str
    api_key_environment: str
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout_seconds: float = 30.0
    input_cost_per_million_tokens: float = 0.0
    output_cost_per_million_tokens: float = 0.0
    cost_tick_divisor: float | None = None
    max_response_bytes: int = 4 * 1024 * 1024

    def __post_init__(self) -> None:
        parsed = urlparse(self.endpoint)
        local = parsed.hostname in {"localhost", "127.0.0.1"}
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("endpoint must not contain credentials")
        if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
            raise ValueError("endpoint must use HTTPS except for local tests")
        if not self.model.strip():
            raise ValueError("model must not be empty")
        if not self.api_key_environment.strip():
            raise ValueError("api_key_environment must not be empty")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if not isinstance(self.max_response_bytes, int) or isinstance(
            self.max_response_bytes, bool
        ) or self.max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be a positive integer")


def responses_adapter_config(
    provider: str, model: str, **overrides: Any
) -> ResponsesAdapterConfig:
    if provider not in {"openrouter", "xai"}:
        raise ValueError("provider must be openrouter or xai")
    values: dict[str, Any] = {
        "endpoint": (
            "https://openrouter.ai/api/v1/responses"
            if provider == "openrouter"
            else "https://api.x.ai/v1/responses"
        ),
        "model": model,
        "api_key_environment": (
            "OPENROUTER_API_KEY" if provider == "openrouter" else "XAI_API_KEY"
        ),
    }
    if provider == "xai":
        values["cost_tick_divisor"] = 10_000_000_000.0
    values.update(overrides)
    return ResponsesAdapterConfig(**values)


def _redact(value: str, secret: str) -> str:
    return value.replace(secret, "[REDACTED]") if secret else value


def _failure(
    message: str, retryable: bool, provider_code: str, secret: str = ""
) -> ModelFailure:
    return ModelFailure(
        FailureKind.PROVIDER,
        _redact(message, secret),
        retryable,
        _redact(provider_code, secret),
    )


def _response_text(payload: Mapping[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    text: list[str] = []
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    for item in output:
        if not isinstance(item, Mapping) or not isinstance(item.get("content"), list):
            continue
        for content in item["content"]:
            if (
                isinstance(content, Mapping)
                and content.get("type") == "output_text"
                and isinstance(content.get("text"), str)
            ):
                text.append(content["text"])
    return "".join(text)


class ResponsesApiAdapter:
    def __init__(
        self,
        config: ResponsesAdapterConfig,
        resolve_secret: SecretResolver,
        http: HttpPort | None = None,
    ) -> None:
        self.config = config
        self.resolve_secret = resolve_secret
        self.http = http or UrlLibHttpPort()

    async def invoke(self, request: ModelRequest) -> ModelSuccess[Mapping[str, Any]] | ModelFailure:
        if not isinstance(request.input, Mapping):
            return _failure("Responses API input must be an object.", False, "invalid_input")
        provider_input = request.input.get("input")
        if not isinstance(provider_input, (str, list)):
            return _failure(
                "Responses API input.input must be text or an item array.", False, "invalid_input"
            )
        api_key = self.resolve_secret(self.config.api_key_environment)
        if not api_key:
            return _failure(
                "The configured API key environment variable is unavailable.",
                False,
                "missing_credentials",
            )
        body: dict[str, Any] = {
            "model": self.config.model,
            "input": provider_input,
            "max_output_tokens": request.max_output_tokens,
            "store": False,
            "stream": False,
        }
        for optional in ("tools", "text", "reasoning"):
            if optional in request.input:
                body[optional] = request.input[optional]
        headers = {
            **self.config.headers,
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        }
        try:
            response = await self.http.post_json(
                self.config.endpoint,
                headers,
                json.dumps(body, separators=(",", ":")).encode("utf-8"),
                self.config.timeout_seconds,
                self.config.max_response_bytes,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return _failure(str(error), True, "network_error", api_key)
        if len(response.body) > self.config.max_response_bytes:
            return _failure(
                "The provider response exceeded the size limit.", False, "response_too_large"
            )
        try:
            parsed: Any = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _failure("The provider returned invalid JSON.", False, "invalid_response")
        payload: Mapping[str, Any] = parsed if isinstance(parsed, Mapping) else {}
        if (
            response.status < 200
            or response.status >= 300
            or payload.get("error") is not None
            or payload.get("status") == "failed"
        ):
            error = payload.get("error") if isinstance(payload.get("error"), Mapping) else {}
            message = (
                error.get("message")
                if isinstance(error.get("message"), str)
                else "The provider rejected the request."
            )
            code = (
                payload.get("error_type")
                if isinstance(payload.get("error_type"), str)
                else error.get("code")
                if isinstance(error.get("code"), str)
                else str(response.status)
            )
            retryable = response.status in {408, 429} or response.status >= 500
            return _failure(message, retryable, code, api_key)
        usage = payload.get("usage") if isinstance(payload.get("usage"), Mapping) else {}
        input_tokens = usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else 0
        output_tokens = usage.get("output_tokens") if isinstance(usage.get("output_tokens"), int) else 0
        ticks = usage.get("cost_in_usd_ticks")
        estimated_cost_usd = (
            float(ticks) / self.config.cost_tick_divisor
            if isinstance(ticks, (int, float))
            and self.config.cost_tick_divisor is not None
            and self.config.cost_tick_divisor > 0
            else (
                input_tokens * self.config.input_cost_per_million_tokens
                + output_tokens * self.config.output_cost_per_million_tokens
            )
            / 1_000_000
        )
        value = {
            "id": payload.get("id") if isinstance(payload.get("id"), str) else "",
            "status": payload.get("status") if isinstance(payload.get("status"), str) else "completed",
            "text": _response_text(payload),
            "output": payload.get("output") if isinstance(payload.get("output"), list) else [],
        }
        return ModelSuccess(value, Usage(input_tokens, output_tokens, estimated_cost_usd))


def register_responses_adapter(
    registry: AdapterRegistry,
    route: str,
    config: ResponsesAdapterConfig,
    resolve_secret: SecretResolver,
    http: HttpPort | None = None,
) -> ResponsesApiAdapter:
    adapter = ResponsesApiAdapter(config, resolve_secret, http)
    registry.register(route, adapter)
    return adapter
`;

const tests = `import json
import unittest
from pathlib import Path

from providers.responses import (
    HttpResponse,
    ResponsesApiAdapter,
    register_responses_adapter,
    responses_adapter_config,
)
from runtime import AdapterRegistry, ModelFailure, ModelRequest, ModelSuccess


CONFORMANCE = json.loads(
    Path(__file__).parent.parent.joinpath("conformance.json").read_text(encoding="utf-8")
)


class FakeHttp:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.authorization = ""
        self.body = {}

    async def post_json(self, endpoint, headers, body, timeout_seconds, max_response_bytes):
        self.authorization = headers["Authorization"]
        self.body = json.loads(body)
        return self.response


class ResponsesProviderTests(unittest.IsolatedAsyncioTestCase):
    request = ModelRequest("provider-1", "primary", "v1", {"input": "hello"}, 1, 20, {})

    async def test_classifies_shared_provider_failure_vectors(self):
        for vector in CONFORMANCE["providerCases"]:
            adapter = ResponsesApiAdapter(
                responses_adapter_config("openrouter", "test/model"),
                lambda _: "secret",
                FakeHttp(HttpResponse(vector["statusCode"], json.dumps(vector["body"]).encode())),
            )
            result = await adapter.invoke(self.request)
            self.assertIsInstance(result, ModelFailure)
            self.assertEqual(result.kind.value, vector["expected"]["failureKind"])
            self.assertEqual(result.provider_code, vector["expected"]["providerCode"])
            self.assertEqual(result.retryable, vector["expected"]["retryable"])

    async def test_maps_output_usage_and_registration(self):
        http = FakeHttp(
            HttpResponse(
                200,
                json.dumps(
                    {
                        "id": "response-1",
                        "status": "completed",
                        "output_text": "world",
                        "output": [],
                        "usage": {"input_tokens": 2, "output_tokens": 3},
                    }
                ).encode(),
            )
        )
        registry = AdapterRegistry()
        adapter = register_responses_adapter(
            registry,
            "primary",
            responses_adapter_config(
                "openrouter",
                "test/model",
                input_cost_per_million_tokens=1,
                output_cost_per_million_tokens=2,
            ),
            lambda _: "test-secret",
            http,
        )
        self.assertIs(registry.get("primary"), adapter)
        result = await adapter.invoke(self.request)
        self.assertIsInstance(result, ModelSuccess)
        self.assertEqual(result.value["text"], "world")
        self.assertEqual(result.usage.estimated_cost_usd, 0.000008)
        self.assertEqual(http.authorization, "Bearer test-secret")
        self.assertFalse(http.body["store"])

    async def test_redacts_secret_and_classifies_rate_limit(self):
        secret = "credential-that-must-not-leak"
        http = FakeHttp(
            HttpResponse(429, json.dumps({"error": {"message": secret, "code": secret}}).encode())
        )
        adapter = ResponsesApiAdapter(
            responses_adapter_config("xai", "grok-test"), lambda _: secret, http
        )
        result = await adapter.invoke(self.request)
        self.assertIsInstance(result, ModelFailure)
        self.assertTrue(result.retryable)
        self.assertNotIn(secret, repr(result))

    async def test_fails_closed_without_credentials(self):
        adapter = ResponsesApiAdapter(
            responses_adapter_config("openrouter", "test/model"), lambda _: None
        )
        result = await adapter.invoke(self.request)
        self.assertIsInstance(result, ModelFailure)
        self.assertEqual(result.provider_code, "missing_credentials")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            responses_adapter_config("openrouter", "test/model", endpoint="http://example.com")

    async def test_rejects_malformed_and_oversized_responses(self):
        malformed = ResponsesApiAdapter(
            responses_adapter_config("openrouter", "test/model"),
            lambda _: "secret",
            FakeHttp(HttpResponse(200, b"not-json")),
        )
        malformed_result = await malformed.invoke(self.request)
        self.assertIsInstance(malformed_result, ModelFailure)
        self.assertEqual(malformed_result.provider_code, "invalid_response")

        oversized = ResponsesApiAdapter(
            responses_adapter_config("openrouter", "test/model", max_response_bytes=8),
            lambda _: "secret",
            FakeHttp(HttpResponse(200, b"123456789")),
        )
        oversized_result = await oversized.invoke(self.request)
        self.assertIsInstance(oversized_result, ModelFailure)
        self.assertEqual(oversized_result.provider_code, "response_too_large")


if __name__ == "__main__":
    unittest.main()
`;

export const pythonProviders: readonly ProviderIntegrationDefinition[] = [
  {
    targets: ["openrouter", "xai-api"],
    artifacts: [
      { path: "providers/__init__.py", source: "" },
      { path: "providers/responses.py", source: responses },
      { path: "providers/test_responses.py", source: tests }
    ]
  }
];
