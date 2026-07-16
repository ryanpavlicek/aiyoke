import type { FrameworkIntegrationDefinition } from "../shared.js";

const axum = `use crate::runtime::{
    ExecuteOptions, FailureKind, HarnessRuntime, ModelRequest, ModelResult,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::json;
use std::sync::Arc;

pub type AxumRequestFactory<I> =
    dyn Fn(I, &HeaderMap) -> Result<ModelRequest<I>, String> + Send + Sync;

pub struct AiyokeAxumState<I, O> {
    pub runtime: Arc<HarnessRuntime<I, O>>,
    pub request_factory: Arc<AxumRequestFactory<I>>,
}

fn axum_failure_status(kind: FailureKind) -> StatusCode {
    match kind {
        FailureKind::GuardRejected => StatusCode::BAD_REQUEST,
        FailureKind::ApprovalRequired => StatusCode::FORBIDDEN,
        FailureKind::BudgetExhausted | FailureKind::RateLimit => StatusCode::TOO_MANY_REQUESTS,
        FailureKind::Timeout => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    }
}

pub async fn aiyoke_axum_handler<I, O>(
    State(state): State<Arc<AiyokeAxumState<I, O>>>,
    headers: HeaderMap,
    Json(input): Json<I>,
) -> Response
where
    I: Clone + DeserializeOwned + Send + Sync + 'static,
    O: Clone + Serialize + Send + Sync + 'static,
{
    let request = match (state.request_factory)(input, &headers) {
        Ok(request) => request,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let runtime = state.runtime.clone();
    match tokio::task::spawn_blocking(move || runtime.execute(request, &ExecuteOptions::default()))
        .await
    {
        Ok(ModelResult::Success { value, usage }) => Json(json!({
            "data": value,
            "usage": {
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "estimatedCostUsd": usage.estimated_cost_usd
            }
        }))
        .into_response(),
        Ok(ModelResult::Failure(failure)) => (
            axum_failure_status(failure.kind),
            Json(json!({ "error": { "message": failure.message } })),
        )
            .into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
`;

const actix = `use crate::runtime::{
    ExecuteOptions, FailureKind, HarnessRuntime, ModelRequest, ModelResult,
};
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::json;
use std::sync::Arc;

pub type ActixRequestFactory<I> =
    dyn Fn(I, &HttpRequest) -> Result<ModelRequest<I>, String> + Send + Sync;

pub struct AiyokeActixState<I, O> {
    pub runtime: Arc<HarnessRuntime<I, O>>,
    pub request_factory: Arc<ActixRequestFactory<I>>,
}

fn actix_failure_status(kind: FailureKind) -> actix_web::http::StatusCode {
    match kind {
        FailureKind::GuardRejected => actix_web::http::StatusCode::BAD_REQUEST,
        FailureKind::ApprovalRequired => actix_web::http::StatusCode::FORBIDDEN,
        FailureKind::BudgetExhausted | FailureKind::RateLimit => {
            actix_web::http::StatusCode::TOO_MANY_REQUESTS
        }
        FailureKind::Timeout => actix_web::http::StatusCode::GATEWAY_TIMEOUT,
        _ => actix_web::http::StatusCode::BAD_GATEWAY,
    }
}

pub async fn aiyoke_actix_handler<I, O>(
    state: web::Data<Arc<AiyokeActixState<I, O>>>,
    request: HttpRequest,
    body: web::Json<I>,
) -> impl Responder
where
    I: Clone + DeserializeOwned + Send + Sync + 'static,
    O: Clone + Serialize + Send + Sync + 'static,
{
    let model_request = match (state.request_factory)(body.into_inner(), &request) {
        Ok(request) => request,
        Err(message) => return HttpResponse::BadRequest().json(json!({ "error": message })),
    };
    let runtime = state.runtime.clone();
    match web::block(move || runtime.execute(model_request, &ExecuteOptions::default())).await {
        Ok(ModelResult::Success { value, usage }) => HttpResponse::Ok().json(json!({
            "data": value,
            "usage": {
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "estimatedCostUsd": usage.estimated_cost_usd
            }
        })),
        Ok(ModelResult::Failure(failure)) => HttpResponse::build(actix_failure_status(failure.kind))
            .json(json!({ "error": { "message": failure.message } })),
        Err(_) => HttpResponse::BadGateway().finish(),
    }
}
`;

export const rustIntegrations: readonly FrameworkIntegrationDefinition[] = [
  { framework: "axum", path: "axum_aiyoke.rs", source: axum },
  { framework: "actix", path: "actix_aiyoke.rs", source: actix }
];
