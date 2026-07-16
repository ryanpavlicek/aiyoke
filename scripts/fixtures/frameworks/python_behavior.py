import asyncio
import json

from django.conf import settings

if not settings.configured:
    settings.configure(DEFAULT_CHARSET="utf-8")

from django.http import HttpRequest
from fastapi import Request
from flask import Flask

from django_aiyoke import create_aiyoke_django_view
from fastapi_aiyoke import create_aiyoke_fastapi_handler
from flask_aiyoke import create_aiyoke_flask_view
from runtime import FailureKind, ModelFailure, ModelRequest, ModelSuccess, Usage


def model_request():
    return ModelRequest(
        request_id="request-1",
        route="primary",
        prompt_version="v1",
        input={"question": "safe"},
        input_tokens=4,
        max_output_tokens=16,
        metadata={"tenant": "fixture"},
    )


SUCCESS = ModelSuccess({"answer": 42}, Usage(4, 2, 0.001))


class Runtime:
    def __init__(self, result, delay=0):
        self.result = result
        self.delay = delay
        self.cancelled = False

    async def execute(self, _request):
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            return self.result
        except asyncio.CancelledError:
            self.cancelled = True
            raise


async def never_cancelled():
    return False


async def cancelled():
    return True


async def main():
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/ai",
        "headers": [(b"authorization", b"Bearer fixture")],
        "query_string": b"",
        "server": ("test", 443),
        "client": ("test", 123),
        "scheme": "https",
    }

    def fastapi_factory(request):
        assert request.headers["authorization"] == "Bearer fixture"
        return model_request()

    fastapi = create_aiyoke_fastapi_handler(
        Runtime(SUCCESS), fastapi_factory, lambda _request: never_cancelled
    )
    response = await fastapi(Request(scope))
    assert response.status_code == 200
    assert json.loads(response.body) == {
        "data": {"answer": 42},
        "usage": {
            "input_tokens": 4,
            "output_tokens": 2,
            "estimated_cost_usd": 0.001,
        },
    }

    timeout = create_aiyoke_fastapi_handler(
        Runtime(ModelFailure(FailureKind.TIMEOUT, "slow", False)),
        lambda _request: model_request(),
        lambda _request: never_cancelled,
    )
    assert (await timeout(Request(scope))).status_code == 504

    django_request = HttpRequest()
    django_request.method = "POST"
    django_request.META["HTTP_AUTHORIZATION"] = "Bearer fixture"

    def django_factory(request):
        assert request.headers["Authorization"] == "Bearer fixture"
        return model_request()

    django = create_aiyoke_django_view(
        Runtime(SUCCESS), django_factory, lambda _request: never_cancelled
    )
    django_response = await django(django_request)
    assert django_response.status_code == 200
    assert json.loads(django_response.content)["data"] == {"answer": 42}

    cancelling_runtime = Runtime(SUCCESS, delay=60)
    cancelling_django = create_aiyoke_django_view(
        cancelling_runtime,
        lambda _request: model_request(),
        lambda _request: cancelled,
    )
    cancelled_response = await asyncio.wait_for(cancelling_django(django_request), timeout=1)
    assert cancelled_response.status_code == 499

    app = Flask(__name__)
    with app.test_request_context(
        "/ai", method="POST", headers={"Authorization": "Bearer fixture"}
    ):

        def flask_factory(request):
            assert request.headers["Authorization"] == "Bearer fixture"
            return model_request()

        flask = create_aiyoke_flask_view(
            Runtime(ModelFailure(FailureKind.APPROVAL_REQUIRED, "approval", False)),
            flask_factory,
            lambda _request: never_cancelled,
        )
        flask_response, status = await flask()
        assert status == 403
        assert flask_response.get_json()["error"]["kind"] == "approval-required"


asyncio.run(main())
print("Python framework request behavior passed.")
