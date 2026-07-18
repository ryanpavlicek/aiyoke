use crate::actix_aiyoke::{aiyoke_actix_handler, AiyokeActixState};
use crate::axum_aiyoke::{aiyoke_axum_handler, AiyokeAxumState};
use crate::runtime::{
    AdapterRegistry, CancellationToken, ExecuteOptions, HarnessRuntime, InvocationContext,
    ModelAdapter, ModelRequest, ModelResult, RetryOptions, RuntimeOptions, RuntimePorts, Usage,
};
use actix_web::{test, web, Responder};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::Json;
use http_body_util::BodyExt;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

struct FrameworkAdapter;

impl ModelAdapter<String, String> for FrameworkAdapter {
    fn invoke(
        &self,
        request: &ModelRequest<String>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        ModelResult::Success {
            value: request.input.clone(),
            usage: Usage {
                input_tokens: 4,
                output_tokens: 2,
                estimated_cost_usd: 0.001,
            },
        }
    }
}

fn runtime() -> Arc<HarnessRuntime<String, String>> {
    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(FrameworkAdapter))
        .unwrap();
    Arc::new(
        HarnessRuntime::new(
            RuntimeOptions {
                timeout: Duration::from_secs(1),
                retry: RetryOptions {
                    max_attempts: 1,
                    base_delay: Duration::from_millis(1),
                    max_delay: Duration::from_millis(10),
                    jitter_ratio: 0.0,
                },
                fallback_routes: vec![],
                max_repair_attempts: 0,
                max_input_tokens: 100,
                max_output_tokens: 100,
                max_estimated_cost_usd: None,
                max_concurrency: 2,
                max_batch_size: 4,
                circuit_failure_threshold: 2,
                circuit_reset_after: Duration::from_secs(1),
                circuit_half_open_max_attempts: 1,
            },
            adapters,
            RuntimePorts::default(),
        )
        .unwrap(),
    )
}

fn request(input: String, authorization: &str) -> ModelRequest<String> {
    ModelRequest {
        id: "request-1".to_owned(),
        route: "primary".to_owned(),
        prompt_version: "v1".to_owned(),
        input,
        input_tokens: 4,
        max_output_tokens: 16,
        metadata: BTreeMap::from([("authorization".to_owned(), authorization.to_owned())]),
    }
}

fn execute_options(cancel: bool) -> ExecuteOptions<String> {
    let cancellation = CancellationToken::default();
    if cancel {
        cancellation.cancel();
    }
    ExecuteOptions {
        cancellation,
        ..ExecuteOptions::default()
    }
}

#[tokio::test]
async fn axum_carries_auth_and_cancellation_options() {
    let state = Arc::new(AiyokeAxumState {
        runtime: runtime(),
        request_factory: Arc::new(|input: String, headers: &HeaderMap| {
            let authorization = headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "authorization required".to_owned())?;
            Ok((
                request(input, authorization),
                execute_options(headers.get("x-cancel").is_some()),
            ))
        }),
    });
    let mut headers = HeaderMap::new();
    headers.insert("authorization", HeaderValue::from_static("Bearer fixture"));
    let response =
        aiyoke_axum_handler(State(state.clone()), headers.clone(), Json("ok".to_owned())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let success_body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(success_body["usage"]["inputTokens"], 4);
    assert_eq!(success_body["usage"]["outputTokens"], 2);
    assert_eq!(success_body["usage"]["estimatedCostUsd"], 0.001);

    headers.insert("x-cancel", HeaderValue::from_static("1"));
    let cancelled = aiyoke_axum_handler(State(state), headers, Json("cancel".to_owned())).await;
    assert_eq!(cancelled.status().as_u16(), 499);
    let failure_body: serde_json::Value =
        serde_json::from_slice(&cancelled.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(failure_body["error"]["kind"], "cancelled");
    assert!(failure_body["error"]["message"].is_string());
}

#[actix_web::test]
async fn actix_carries_auth_and_cancellation_options() {
    let state = web::Data::new(Arc::new(AiyokeActixState {
        runtime: runtime(),
        request_factory: Arc::new(|input: String, incoming: &actix_web::HttpRequest| {
            let authorization = incoming
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "authorization required".to_owned())?;
            Ok((
                request(input, authorization),
                execute_options(incoming.headers().contains_key("x-cancel")),
            ))
        }),
    }));
    let incoming = test::TestRequest::default()
        .insert_header(("authorization", "Bearer fixture"))
        .to_http_request();
    let response =
        aiyoke_actix_handler(state.clone(), incoming.clone(), web::Json("ok".to_owned()))
            .await
            .respond_to(&incoming);
    assert_eq!(response.status(), actix_web::http::StatusCode::OK);

    let cancelled_request = test::TestRequest::default()
        .insert_header(("authorization", "Bearer fixture"))
        .insert_header(("x-cancel", "1"))
        .to_http_request();
    let cancelled = aiyoke_actix_handler(
        state,
        cancelled_request.clone(),
        web::Json("cancel".to_owned()),
    )
    .await
    .respond_to(&cancelled_request);
    assert_eq!(cancelled.status().as_u16(), 499);
}
